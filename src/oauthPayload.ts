// The openrouter_signin IPC payload, kept free of ./db so `node --test` can import it. Rust reads these exact keys.
export type Pkce = { verifier: string; challenge: string; state: string };

export function signInPayload(p: Pkce, seq: number, epoch: string) {
  return { verifier: p.verifier, challenge: p.challenge, state: p.state, seq, epoch };
}
