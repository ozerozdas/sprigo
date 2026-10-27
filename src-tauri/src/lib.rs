use tauri::Manager;

mod companion;
mod data;

/// User-installed courses (DECISIONS B3): `<app data>/courses/*.yml`, returned as (file name, text).
/// The folder is created on first call so users can find where to drop files.
#[tauri::command]
fn list_user_courses(app: tauri::AppHandle) -> Result<Vec<(String, String)>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("courses");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if matches!(path.extension().and_then(|e| e.to_str()), Some("yml" | "yaml")) {
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            out.push((name, std::fs::read_to_string(&path).map_err(|e| e.to_string())?));
        }
    }
    Ok(out)
}

/// Beta channel (#41): the updater's JS `check()` can't change endpoints, so beta testers check here.
/// The `updater-beta` release holds the latest.json of the newest published release, pre-releases included
/// (.github/workflows/channel.yml). Same metadata as the plugin's own `check`, so `new Update(meta)` installs it.
const BETA_ENDPOINT: &str = "https://github.com/ozerozdas/sprigo/releases/download/updater-beta/latest.json";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateMeta {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
async fn check_beta(webview: tauri::Webview) -> Result<Option<UpdateMeta>, String> {
    use tauri_plugin_updater::UpdaterExt;
    let url = tauri::Url::parse(BETA_ENDPOINT).map_err(|e| e.to_string())?;
    let updater = webview.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
    Ok(updater.check().await.map_err(|e| e.to_string())?.map(|u| UpdateMeta {
        current_version: u.current_version.clone(),
        version: u.version.clone(),
        body: u.body.clone(),
        raw_json: u.raw_json.clone(),
        rid: webview.resources_table().add(u),
    }))
}

/// API keys live in the OS keychain (DECISIONS A6), never in SQLite.
fn secret_entry(key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.ozerozdas.sprigo", key).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(key: String) -> Result<Option<String>, String> {
    match secret_entry(&key)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// `None` deletes the key.
#[tauri::command]
fn secret_set(key: String, value: Option<String>) -> Result<(), String> {
    let entry = secret_entry(&key)?;
    match value {
        Some(v) => entry.set_password(&v).map_err(|e| e.to_string()),
        None => match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// Speech-to-text (DECISIONS D2): whisper.cpp runs in-process (Metal on Apple silicon); the model ships inside
/// the app bundle, so nothing has to be installed or started. Loaded on first use, then kept in memory.
const STT_MODEL: &str = "resources/ggml-base-q5_1.bin";
static STT: std::sync::Mutex<Option<(std::path::PathBuf, whisper_rs::WhisperContext)>> = std::sync::Mutex::new(None);

/// Bigger Whisper models the learner can download (Settings > Speech recognition > gear): `<app data>/models/<file>`.
/// `models/whisper.txt` names the chosen one; without it (or its file) the bundled base model is used.
fn stt_file(name: &str) -> Option<&'static str> {
    match name {
        "small" => Some("ggml-small-q5_1.bin"),
        "turbo" => Some("ggml-large-v3-turbo-q5_0.bin"),
        _ => None,
    }
}
fn models_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("models"))
}

fn stt_model(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    if let Ok(dir) = models_dir(app) {
        let chosen = std::fs::read_to_string(dir.join("whisper.txt")).unwrap_or_default();
        if let Some(p) = stt_file(chosen.trim()).map(|f| dir.join(f)).filter(|p| p.exists()) {
            return Some(p);
        }
    }
    let p = app.path().resolve(STT_MODEL, tauri::path::BaseDirectory::Resource).ok()?;
    p.exists().then_some(p)
}

/// (model in use, downloaded models).
#[tauri::command]
fn stt_models(app: tauri::AppHandle) -> Result<(String, Vec<String>), String> {
    let dir = models_dir(&app)?;
    let chosen = std::fs::read_to_string(dir.join("whisper.txt")).unwrap_or_default().trim().to_string();
    let have: Vec<String> = ["small", "turbo"].iter().filter(|n| dir.join(stt_file(n).unwrap()).exists()).map(|n| n.to_string()).collect();
    Ok((if have.contains(&chosen) { chosen } else { "base".into() }, have))
}

/// Uses `name` from the next recording on; "base" is the bundled model.
#[tauri::command]
fn stt_use(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("whisper.txt"), name).map_err(|e| e.to_string())
}

/// Deletes a downloaded model; if it was in use, the bundled base model takes over.
#[tauri::command]
fn stt_remove(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let file = stt_file(&name).ok_or("unknown model")?;
    let dir = models_dir(&app)?;
    if std::fs::read_to_string(dir.join("whisper.txt")).unwrap_or_default().trim() == name {
        let _ = std::fs::remove_file(dir.join("whisper.txt"));
    }
    if let Ok(mut g) = STT.lock() {
        if g.as_ref().is_some_and(|(p, _)| p.ends_with(file)) { g.take(); } // free its memory too
    }
    std::fs::remove_file(dir.join(file)).map_err(|e| e.to_string())
}

/// Downloads `name` from the whisper.cpp model repo, reporting 0..1 on `progress`.
#[tauri::command]
async fn stt_download(app: tauri::AppHandle, name: String, progress: tauri::ipc::Channel<f64>) -> Result<(), String> {
    let file = stt_file(&name).ok_or("unknown model")?;
    let dir = models_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        use std::io::{Read, Write};
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let url = format!("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/{file}");
        let client = tauri_plugin_http::reqwest::blocking::Client::builder().timeout(None).build().map_err(|e| e.to_string())?;
        let mut res = client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string())?;
        let total = res.content_length().unwrap_or(0) as f64;
        let part = dir.join(format!("{file}.part"));
        let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let (mut buf, mut got, mut sent) = (vec![0u8; 1 << 16], 0f64, 0f64);
        loop {
            let n = res.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
            got += n as f64;
            if total > 0.0 && got / total - sent >= 0.01 { sent = got / total; let _ = progress.send(sent); }
        }
        drop(out);
        std::fs::rename(&part, dir.join(file)).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn stt_ready(app: tauri::AppHandle) -> bool {
    stt_model(&app).is_some()
}

/// `samples`: mono f32 PCM at 16 kHz; `lang`: ISO 639-1 of the course. Runs off the main thread.
#[tauri::command]
async fn transcribe(app: tauri::AppHandle, samples: Vec<f32>, lang: String) -> Result<String, String> {
    let model = stt_model(&app).ok_or("Speech model is missing from this build")?;
    tauri::async_runtime::spawn_blocking(move || whisper_text(&model, &samples, &lang))
        .await
        .map_err(|e| e.to_string())?
}

fn whisper_text(model: &std::path::Path, samples: &[f32], lang: &str) -> Result<String, String> {
    // ponytail: one global lock, recordings are short and one learner speaks at a time
    let mut guard = STT.lock().map_err(|e| e.to_string())?;
    if guard.as_ref().map_or(true, |(p, _)| p != model) { // first use, or another model was picked
        guard.take(); // free the old one before loading the next
        let path = model.to_str().ok_or("bad model path")?;
        *guard = Some((model.to_path_buf(), whisper_rs::WhisperContext::new_with_params(path, Default::default()).map_err(|e| e.to_string())?));
    }
    let mut state = guard.as_ref().unwrap().1.create_state().map_err(|e| e.to_string())?;
    let mut params = whisper_rs::FullParams::new(whisper_rs::SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(lang));
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_special(false);
    params.set_print_timestamps(false);
    params.set_no_context(true);
    params.set_single_segment(true);
    state.full(params, samples).map_err(|e| e.to_string())?;
    let text: String = state.as_iter().map(|s| s.to_string()).collect();
    Ok(text.trim().to_string())
}

#[cfg(test)]
mod tests {
    /// `sentence` spoken by macOS `say` (with `voice`, if given), then transcribed in `lang`.
    fn heard(voice: Option<&str>, sentence: &str, lang: &str) -> String {
        let wav = std::env::temp_dir().join(format!("sprigo-stt-test-{lang}.wav"));
        let mut say = std::process::Command::new("say");
        if let Some(v) = voice { say.args(["-v", v]); }
        let ok = say.args(["-o", wav.to_str().unwrap(), "--data-format=LEI16@16000", sentence]).status().unwrap().success();
        assert!(ok);
        let bytes = std::fs::read(&wav).unwrap();
        // ponytail: skip the 4 KB header region `say` writes; leading silence is harmless to whisper
        let pcm = &bytes[4096..];
        let samples: Vec<f32> = pcm.chunks_exact(2).map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0).collect();
        let model = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(super::STT_MODEL);
        let text = super::whisper_text(&model, &samples, lang).unwrap().to_lowercase();
        super::release_stt();
        println!("heard: {text}");
        text
    }

    /// Needs the model: `pnpm fetch-model`, then `cargo test -- --ignored`. Speech comes from macOS `say`.
    #[test]
    #[ignore]
    fn whisper_transcribes_speech() {
        let text = heard(None, "Nice to meet you. How are you today?", "en");
        assert!(text.contains("nice to meet you"), "{text}");
    }

    /// The Hungarian course, spoken by the macOS Hungarian voice (Tünde).
    #[test]
    #[ignore]
    fn whisper_transcribes_hungarian() {
        let text = heard(Some("Tünde"), "Jó napot kívánok! Egy kávét kérek.", "hu");
        // whisper may write "jó napot" as one word; the lesson's speech check (speechMisses) accepts that too
        let flat = text.replace(' ', "");
        assert!(flat.contains("jónapotkívánok") && flat.contains("kávétkérek"), "{text}");
    }
}

/// Daily reminder (Settings): the check runs in the webview, so the app must stay alive to fire it.
/// While on, closing the window only hides it and the app starts hidden at login.
static KEEP_ALIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
const HIDDEN_ARG: &str = "--hidden";

#[tauri::command]
fn set_background(app: tauri::AppHandle, on: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    KEEP_ALIVE.store(on, std::sync::atomic::Ordering::Relaxed);
    let launch = app.autolaunch();
    // Skip no-op writes: enable() rewrites the LaunchAgent plist every time.
    if launch.is_enabled().unwrap_or(false) != on {
        if on { launch.enable() } else { launch.disable() }.map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_sql::Builder::default().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_autostart::Builder::new().args([HIDDEN_ARG]).build())
        .setup(|app| {
            // The window starts invisible (tauri.conf.json); a login launch keeps it that way.
            if !std::env::args().any(|a| a == HIDDEN_ARG) {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = e {
                if KEEP_ALIVE.load(std::sync::atomic::Ordering::Relaxed) {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![list_user_courses, check_beta, secret_get, secret_set, stt_ready, stt_models, stt_use, stt_remove, stt_download, transcribe, set_background,
            companion::companion_set, companion::companion_status, companion::companion_reply,
            data::data_location, data::set_data_dir, data::dir_ok, data::file_exists, data::lock_read, data::lock_write,
            data::lock_remove, data::backups_list, data::backups_remove, data::copy_file, data::write_text, data::is_sqlite, data::install_db])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            // Dock icon click brings a hidden window back.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { has_visible_windows: false, .. } => show_main(app),
            tauri::RunEvent::Exit => {
                companion::stop();
                release_stt();
                data::release_lock();
            }
            _ => {}
        });
}

/// ggml-metal asserts at process exit if a model is still loaded (SIGABRT → "quit unexpectedly"); free it first.
fn release_stt() {
    if let Ok(mut g) = STT.lock() {
        g.take();
    }
}
