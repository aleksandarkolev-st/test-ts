pub mod auth;
pub mod client;
pub mod prompts;

pub fn acceptance_mode() -> bool {
    #[cfg(all(feature = "acceptance", debug_assertions))]
    {
        return std::env::var("COPILOT_ACCEPTANCE").as_deref() == Ok("1");
    }
    #[cfg(not(all(feature = "acceptance", debug_assertions)))]
    false
}
