pub mod auth;
pub mod client;
mod mailbox;
pub mod codex;
pub mod prompts;
pub mod timing;
pub mod responses_ws;
pub mod realtime;

pub fn acceptance_mode() -> bool {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    {
        return std::env::var("COPILOT_ACCEPTANCE").as_deref() == Ok("1");
    }
    #[cfg(not(all(feature = "acceptance", debug_assertions)))]
    false
}

// Instrumented native runs can exercise either a local HTTP fixture or the
// actual signed-in Codex service. Injection alone must not fake authentication.
pub fn http_fixture_mode() -> bool {
    acceptance_mode() && std::env::var_os("COPILOT_TEST_API").is_some()
}

// Explicitly authorized live-plan replay uses normal credential loading and
// refresh persistence. Ordinary acceptance fixtures must remain isolated.
pub fn authenticated_acceptance_mode() -> bool {
    authenticated_acceptance(acceptance_mode(), http_fixture_mode(),
        std::env::var("COPILOT_ACCEPTANCE_REAL_AUTH").as_deref() == Ok("1"))
}
fn authenticated_acceptance(acceptance:bool,fixture:bool,opt_in:bool)->bool {
    acceptance && !fixture && opt_in
}
#[cfg(test)]
mod acceptance_auth_tests {
    use super::authenticated_acceptance;
    #[test]
    fn real_credentials_require_explicit_live_acceptance() {
        assert!(!authenticated_acceptance(true,false,false));
        assert!(authenticated_acceptance(true,false,true));
        assert!(!authenticated_acceptance(false,false,true));
    }
    #[test]
    fn local_http_fixtures_never_load_normal_credentials() {
        assert!(!authenticated_acceptance(true,true,true));
        assert!(!authenticated_acceptance(true,true,false));
    }
}
