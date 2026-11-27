//! OpenRouter sign-in (#197, OAuth PKCE). A one-shot HTTP server on 127.0.0.1 catches the browser's callback;
//! Rust exchanges the code and saves the API key in the OS keychain (DECISIONS A6). Neither the code nor the key is
//! logged. The key itself lives in the keychain: the settings sheet reads it back later, like a pasted key.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

const AUTH: &str = "https://openrouter.ai/auth";
const EXCHANGE: &str = "https://openrouter.ai/api/v1/auth/keys";
const CALLBACK: &str = "/callback";
const WAIT: Duration = Duration::from_secs(600); // OpenRouter's codes expire after ten minutes

/// The sign-in in progress, keyed by its PKCE `state` (unique per attempt): a cancel or cleanup names the attempt
/// it belongs to, so a late cancel from a closed sheet, or an older attempt finishing, never touches a newer one.
struct Active {
    state: String,
    /// The webview's request order for sign-ins (starts may run in any order on the async pool).
    seq: u64,
    /// Random per webview load: after a reload the counter restarts, so seq is only compared within one epoch.
    epoch: String,
    server: Arc<Server>,
    cancelled: Arc<AtomicBool>,
}

static ACTIVE: Mutex<Option<Active>> = Mutex::new(None);
/// A cancel that arrived before its attempt registered (the sheet closed while the command was still starting):
/// that attempt then returns "cancelled" at once instead of opening the browser and waiting ten minutes.
static CANCELLED_EARLY: Mutex<Vec<String>> = Mutex::new(Vec::new());
const EARLY_MAX: usize = 8; // a dead entry (its attempt already ended) must not grow this forever

const DONE_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sprigo</title>
<body style=\"font-family:system-ui;padding:12vh 1.5rem;text-align:center\">
<h1>Signed in to OpenRouter</h1><p>You can close this tab and return to Sprigo.</p>";
const DENIED_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sprigo</title>
<body style=\"font-family:system-ui;padding:12vh 1.5rem;text-align:center\">
<h1>Sign-in cancelled</h1><p>Nothing was changed. You can close this tab.</p>";
const BAD_REQUEST_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sprigo</title>
<body style=\"font-family:system-ui;padding:12vh 1.5rem;text-align:center\">
<h1>Sign-in could not be completed</h1><p>Close this tab and try again from Sprigo.</p>";
const NOT_FOUND_PAGE: &str = "<!doctype html><meta charset=utf-8><title>Sprigo</title>
<body style=\"font-family:system-ui;padding:12vh 1.5rem;text-align:center\">
<h1>Not found</h1>";

enum Waiting {
    Code(String),
    Denied,
    Cancelled,
    Timeout,
}

/// What one callback request means. `Reject` answers with that status and keeps waiting: a stray request, a broken
/// page or another app's attempt must not end the learner's sign-in.
#[derive(Debug, PartialEq)]
enum Callback {
    Code(String),
    Denied,
    Reject(u16),
}

fn page(status: u16, body: &'static str) -> Response<std::io::Cursor<Vec<u8>>> {
    Response::from_string(body)
        .with_status_code(StatusCode(status))
        .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap())
        .with_header(Header::from_bytes("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'").unwrap())
        .with_header(Header::from_bytes("X-Frame-Options", "DENY").unwrap())
}

fn header<'a>(req: &'a Request, name: &'static str) -> Option<&'a str> {
    req.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

/// Opens the browser at OpenRouter's consent page and waits (up to ten minutes) for the loopback callback.
/// `challenge` and `state` come from the webview's PKCE helper; `verifier` returns with the code to exchange.
/// Returns "ok", "cancelled" or "timeout" so the sheet can stay quiet on a close and explain a timeout.
#[tauri::command]
pub async fn openrouter_signin(app: tauri::AppHandle, challenge: String, verifier: String, state: String, seq: u64, epoch: String) -> Result<String, String> {
    if [&challenge, &verifier, &state].iter().any(|v| v.is_empty() || v.len() > 256) {
        return Err("The sign-in request is incomplete".into());
    }
    let (server, cancelled) = {
        let mut slot = ACTIVE.lock().map_err(|e| e.to_string())?;
        {
            let mut early = CANCELLED_EARLY.lock().map_err(|e| e.to_string())?;
            let before = early.len();
            early.retain(|s| *s != state);
            if early.len() != before {
                return Ok("cancelled".into());
            }
        }
        // An older request that only now got to run: the learner has already moved on to a newer attempt.
        if slot.as_ref().is_some_and(|a| yields_to(a, seq, &epoch)) {
            return Ok("cancelled".into());
        }
        // Port 0: the OS picks a free port, which OpenRouter allows for localhost callbacks.
        let server = Arc::new(Server::http(("127.0.0.1", 0)).map_err(|e| e.to_string())?);
        let cancelled = Arc::new(AtomicBool::new(false));
        take_over(&mut slot, Active { state: state.clone(), seq, epoch, server: server.clone(), cancelled: cancelled.clone() });
        (server, cancelled)
    };
    let port = match server.server_addr().to_ip() {
        Some(addr) => addr.port(),
        None => {
            finish(&state);
            return Err("Could not start the sign-in listener".into());
        }
    };
    let url = match auth_url(&format!("http://127.0.0.1:{port}{CALLBACK}"), &challenge, &state) {
        Ok(url) => url,
        Err(e) => {
            finish(&state);
            return Err(e);
        }
    };

    // A cancel may have landed between registering and here: do not open a consent tab for a dead attempt.
    if cancelled.load(Ordering::SeqCst) {
        finish(&state);
        return Ok("cancelled".into());
    }
    use tauri_plugin_opener::OpenerExt;
    if let Err(e) = app.opener().open_url(url, None::<&str>) {
        finish(&state);
        return Err(e.to_string());
    }
    let attempt = state.clone();
    let waited = tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        match wait_for_callback(&server, &cancelled, port, &attempt) {
            Waiting::Code(code) => {
                // tiny_http queues requests ahead of the unblock marker, so a cancelled or superseded attempt can
                // still be handed its callback: it must not exchange the code or overwrite the newer attempt's key.
                // (A cancel landing during the exchange itself still saves the key: the code was already spent.)
                if cancelled.load(Ordering::SeqCst) {
                    return Ok("cancelled".into());
                }
                exchange(&code, &verifier)?;
                Ok("ok".into())
            }
            Waiting::Denied | Waiting::Cancelled => Ok("cancelled".into()),
            Waiting::Timeout => Ok("timeout".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
    finish(&state);
    waited
}

/// Stops the sign-in whose PKCE `state` this is, e.g. when its sheet closes. Any other attempt is left alone; a
/// cancel for an attempt that has not registered yet is remembered so it ends as soon as it starts.
#[tauri::command]
pub fn openrouter_cancel(state: String) {
    let Ok(slot) = ACTIVE.lock() else { return };
    match slot.as_ref() {
        Some(active) if active.state == state => {
            active.cancelled.store(true, Ordering::SeqCst);
            active.server.unblock();
        }
        _ => {
            if let Ok(mut early) = CANCELLED_EARLY.lock() {
                if early.len() >= EARLY_MAX {
                    early.remove(0);
                }
                early.push(state);
            }
        }
    }
}

/// App exit: frees the port if a sign-in is still waiting, ending it as cancelled.
pub fn stop() {
    if let Ok(mut slot) = ACTIVE.lock() {
        if let Some(active) = slot.take() {
            active.cancelled.store(true, Ordering::SeqCst);
            active.server.unblock();
        }
    }
}

/// True when this request is older than the running attempt (same webview load) and must yield to it.
fn yields_to(active: &Active, seq: u64, epoch: &str) -> bool {
    active.epoch == epoch && active.seq > seq
}

/// A newer attempt supersedes a leftover one (its sheet is gone or the learner clicked again): the old wait ends as
/// "cancelled" and frees its port, so nothing can block a new sign-in for ten minutes.
fn take_over(slot: &mut Option<Active>, next: Active) {
    if let Some(old) = slot.replace(next) {
        old.cancelled.store(true, Ordering::SeqCst);
        old.server.unblock();
    }
}

/// Clears the slot only if it still holds this attempt: a superseded attempt must not end its successor.
fn finish(state: &str) {
    if let Ok(mut slot) = ACTIVE.lock() {
        if slot.as_ref().is_some_and(|a| a.state == state) {
            if let Some(active) = slot.take() {
                active.server.unblock();
            }
        }
    }
}

fn auth_url(callback: &str, challenge: &str, state: &str) -> Result<String, String> {
    let mut url = tauri::Url::parse(AUTH).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("callback_url", callback)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        .append_pair("key_label", "Sprigo");
    Ok(url.to_string())
}

/// `unblock()` (a cancel, or the app exiting) makes `recv_timeout` return Ok(None) in tiny_http 0.12, and a broken
/// listener returns Err: both mean the wait ended early, and only this attempt's flag says whether it was a cancel.
fn end_of_wait(cancelled: &AtomicBool) -> Waiting {
    if cancelled.swap(false, Ordering::SeqCst) { Waiting::Cancelled } else { Waiting::Timeout }
}

fn wait_for_callback(server: &Server, cancelled: &AtomicBool, port: u16, state: &str) -> Waiting {
    let deadline = Instant::now() + WAIT;
    loop {
        if cancelled.load(Ordering::SeqCst) {
            return end_of_wait(cancelled);
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Waiting::Timeout;
        }
        match server.recv_timeout(left) {
            Ok(None) | Err(_) => return end_of_wait(cancelled),
            Ok(Some(req)) => {
                if let Some(done) = handle(req, port, state) {
                    return done;
                }
            }
        }
    }
}

/// The callback request; None for anything that was answered and should not end the wait (a favicon, a stray page).
fn handle(req: Request, port: u16, state: &str) -> Option<Waiting> {
    if *req.method() != Method::Get {
        let _ = req.respond(page(405, BAD_REQUEST_PAGE));
        return None;
    }
    let host = header(&req, "Host").unwrap_or("").to_string();
    let target = req.url().to_string();
    match callback(&host, &target, port, state) {
        Callback::Code(code) => {
            let _ = req.respond(page(200, DONE_PAGE));
            Some(Waiting::Code(code))
        }
        Callback::Denied => {
            let _ = req.respond(page(200, DENIED_PAGE));
            Some(Waiting::Denied)
        }
        Callback::Reject(status) => {
            let _ = req.respond(page(status, if status == 404 { NOT_FOUND_PAGE } else { BAD_REQUEST_PAGE }));
            None
        }
    }
}

/// What the request's Host, target and query say, with no side effects: only a code plus this attempt's state
/// completes the sign-in, and only an `error` from OpenRouter counts as declining.
fn callback(host: &str, target: &str, port: u16, state: &str) -> Callback {
    // Exact host and port: a web page that rebinds its domain to loopback sends its own Host, and the browser
    // navigation to our callback always carries the address we opened.
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return Callback::Reject(403);
    }
    if !target.starts_with('/') {
        return Callback::Reject(400); // absolute-form (a proxy request) or "*", never a browser navigation
    }
    let Ok(url) = tauri::Url::parse(&format!("http://127.0.0.1:{port}{target}")) else {
        return Callback::Reject(400);
    };
    if url.path() != CALLBACK {
        return Callback::Reject(404);
    }
    let (mut code, mut returned_state, mut denied) = (None, None, false);
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => returned_state = Some(v.into_owned()),
            "error" | "error_description" => denied = true, // the learner declined on OpenRouter's page
            _ => {}
        }
    }
    if denied {
        return Callback::Denied;
    }
    let code = code.filter(|c| !c.is_empty());
    match code {
        // Neither a code nor an error: not an answer to this sign-in, so keep waiting for the real callback.
        None => Callback::Reject(400),
        Some(_) if returned_state.as_deref() != Some(state) => Callback::Reject(400),
        Some(code) => Callback::Code(code),
    }
}

/// Exchanges the one-time code for an API key and stores it in the keychain. A failed exchange never logs the code.
fn exchange(code: &str, verifier: &str) -> Result<(), String> {
    let client = tauri_plugin_http::reqwest::blocking::Client::builder().timeout(Duration::from_secs(30)).build().map_err(|e| e.to_string())?;
    let res = client
        .post(EXCHANGE)
        .header("Content-Type", "application/json")
        .body(serde_json::json!({ "code": code, "code_verifier": verifier, "code_challenge_method": "S256" }).to_string())
        .send()
        .map_err(|e| e.to_string())?;
    let status = res.status();
    // The plugin's reqwest has no `json` feature: read the text and parse it here.
    let body: serde_json::Value = serde_json::from_str(&res.text().unwrap_or_default()).unwrap_or_default();
    if !status.is_success() {
        let msg = body["error"]["message"].as_str()
            .or_else(|| body["error"].as_str())
            .or_else(|| body["message"].as_str())
            .unwrap_or("OpenRouter refused the sign-in");
        return Err(format!("{msg} ({})", status.as_u16()));
    }
    let key = body["key"].as_str().filter(|k| !k.is_empty()).ok_or("OpenRouter did not return a key")?;
    crate::secret_entry("api-key.openrouter")?.set_password(key).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PORT: u16 = 51234;

    #[test]
    fn auth_url_carries_pkce_and_the_loopback_callback() {
        let url = tauri::Url::parse(&auth_url("http://127.0.0.1:51234/callback", "ch", "st").unwrap()).unwrap();
        assert_eq!(url.as_str().split('?').next(), Some(AUTH));
        let q: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(q.get("callback_url").map(String::as_str), Some("http://127.0.0.1:51234/callback"));
        assert_eq!(q.get("code_challenge").map(String::as_str), Some("ch"));
        assert_eq!(q.get("code_challenge_method").map(String::as_str), Some("S256"));
        assert_eq!(q.get("state").map(String::as_str), Some("st"));
    }

    #[test]
    fn callback_means_only_the_state_matching_code_or_an_error() {
        let host = "127.0.0.1:51234";
        let cases: &[(&str, &str, Callback)] = &[
            // the real callback, from either loopback name
            (host, "/callback?code=abc&state=st", Callback::Code("abc".into())),
            ("localhost:51234", "/callback?state=st&code=abc", Callback::Code("abc".into())),
            // a code for another attempt (or none) never completes this one
            (host, "/callback?code=abc&state=other", Callback::Reject(400)),
            (host, "/callback?code=abc", Callback::Reject(400)),
            (host, "/callback?code=&state=st", Callback::Reject(400)),
            // OpenRouter's refusal
            (host, "/callback?error=access_denied&error_description=no", Callback::Denied),
            (host, "/callback?state=st&error=access_denied", Callback::Denied),
            // neither a code nor an error: a stray page, answered and ignored
            (host, "/callback", Callback::Reject(400)),
            (host, "/callback?state=st", Callback::Reject(400)),
            // other hosts, ports, paths and request forms
            ("evil.test:51234", "/callback?code=abc&state=st", Callback::Reject(403)),
            ("127.0.0.1:9999", "/callback?code=abc&state=st", Callback::Reject(403)),
            ("127.0.0.1", "/callback?code=abc&state=st", Callback::Reject(403)),
            (host, "/favicon.ico", Callback::Reject(404)),
            (host, "/", Callback::Reject(404)),
            (host, "http://127.0.0.1:51234/callback?code=abc&state=st", Callback::Reject(400)),
            (host, "*", Callback::Reject(400)),
        ];
        for (host, target, want) in cases {
            assert_eq!(&callback(host, target, PORT, "st"), want, "{host} {target}");
        }
    }

    #[test]
    fn a_cancel_ends_this_wait_and_only_this_one() {
        let cancelled = AtomicBool::new(true);
        assert!(matches!(end_of_wait(&cancelled), Waiting::Cancelled));
        // consumed by the swap: a later early return in this attempt is not another cancel
        assert!(!cancelled.load(Ordering::SeqCst));
        assert!(matches!(end_of_wait(&cancelled), Waiting::Timeout));
    }

    #[test]
    fn an_older_request_yields_only_within_the_same_webview_load() {
        let a = Active { state: "s".into(), seq: 5, epoch: "e1".into(), server: Arc::new(Server::http(("127.0.0.1", 0)).unwrap()), cancelled: Arc::new(AtomicBool::new(false)) };
        assert!(yields_to(&a, 4, "e1"));
        assert!(!yields_to(&a, 5, "e1"));
        assert!(!yields_to(&a, 6, "e1"));
        assert!(!yields_to(&a, 1, "e2")); // after a reload the counter restarts: a new load always takes over
    }

    // The only test touching ACTIVE / CANCELLED_EARLY, so it cannot race another test.
    #[test]
    fn cancel_and_cleanup_only_reach_their_own_attempt() {
        let register = |state: &str| {
            let flag = Arc::new(AtomicBool::new(false));
            let server = Arc::new(Server::http(("127.0.0.1", 0)).unwrap());
            *ACTIVE.lock().unwrap() = Some(Active { state: state.into(), seq: 1, epoch: "e".into(), server, cancelled: flag.clone() });
            flag
        };
        let b = register("attempt-b");
        // a late cancel from an older sheet
        openrouter_cancel("attempt-a".into());
        assert!(!b.load(Ordering::SeqCst));
        // an older attempt finishing does not free the newer one's slot
        finish("attempt-a");
        assert!(ACTIVE.lock().unwrap().is_some());
        // the right cancel reaches it, and its own finish clears the slot
        openrouter_cancel("attempt-b".into());
        assert!(b.load(Ordering::SeqCst));
        finish("attempt-b");
        assert!(ACTIVE.lock().unwrap().is_none());
        // cancels for attempts that are not running are all remembered, until they register
        openrouter_cancel("attempt-c".into());
        assert_eq!(*CANCELLED_EARLY.lock().unwrap(), ["attempt-a", "attempt-c"]);
        // a new attempt supersedes a leftover one: the old wait ends as cancelled
        let d = register("attempt-d");
        let flag = Arc::new(AtomicBool::new(false));
        let server = Arc::new(Server::http(("127.0.0.1", 0)).unwrap());
        take_over(&mut ACTIVE.lock().unwrap(), Active { state: "attempt-e".into(), seq: 2, epoch: "e".into(), server, cancelled: flag.clone() });
        assert!(d.load(Ordering::SeqCst));
        assert!(!flag.load(Ordering::SeqCst));
        stop(); // app exit ends the running attempt as cancelled
        assert!(flag.load(Ordering::SeqCst));
        assert!(ACTIVE.lock().unwrap().is_none());
        for _ in 0..EARLY_MAX + 2 {
            openrouter_cancel("dead".into());
        }
        assert_eq!(CANCELLED_EARLY.lock().unwrap().len(), EARLY_MAX);
        CANCELLED_EARLY.lock().unwrap().clear();
    }
}
