//! Parsing for the two vision-model outputs of the screen monitor: the JSON
//! analysis of a captured frame and the solution-only text that is later typed.
//!
//! The model is instructed to answer with JSON only and to return solutions
//! without code fences, but both are treated as untrusted formatting: fences
//! are stripped defensively and an analysis that does not parse fails
//! explicitly instead of guessing.
use serde::Deserialize;

/// Longest question text accepted from one analysis frame.
pub const MAX_QUESTION_CHARS: usize = 4000;
/// Notes are truncated, not rejected: they are advisory context only.
pub const MAX_NOTE_CHARS: usize = 300;
/// Solutions longer than this are surfaced as a warning and never cached.
pub const MAX_SOLUTION_CHARS: usize = 8000;

/// One parsed vision analysis of a monitor frame. `question` is the answerable
/// task detected on screen, `focus` is the vision-only evidence that the exact
/// answer field is focused, and `password` guards against typing into secrets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Analysis {
    pub question: Option<String>,
    pub focus: bool,
    pub password: bool,
    pub note: String,
}

#[derive(Deserialize)]
struct RawAnalysis {
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    focus: bool,
    #[serde(default)]
    password: bool,
    #[serde(default)]
    note: String,
}

/// Parses the analysis JSON out of raw model output. Surrounding prose and a
/// single fenced code block are tolerated; anything without a JSON object, or
/// with an unusable question, is an explicit error.
pub fn parse_analysis(raw: &str) -> Result<Analysis, String> {
    let json = json_object(raw).ok_or("The vision model did not return a JSON analysis")?;
    let parsed: RawAnalysis = serde_json::from_str(json)
        .map_err(|_| "The vision model returned an invalid analysis".to_string())?;
    let question = parsed
        .question
        .map(|question| question.trim().to_string())
        .filter(|question| !question.is_empty());
    if question
        .as_ref()
        .is_some_and(|question| question.chars().count() > MAX_QUESTION_CHARS)
    {
        return Err("The detected screen question exceeds the size limit".into());
    }
    let note = parsed.note.trim().chars().take(MAX_NOTE_CHARS).collect();
    Ok(Analysis {
        question,
        focus: parsed.focus,
        password: parsed.password,
        note,
    })
}

/// Normalizes a solution for caching and typing: trims outer whitespace and
/// removes at most one wrapping code fence (including a language tag line).
/// Empty results are preserved so callers can warn instead of typing nothing.
pub fn clean_solution(raw: &str) -> String {
    let text = raw.trim();
    let inner = strip_fence(text);
    inner.trim().to_string()
}

fn strip_fence(text: &str) -> &str {
    let Some(body) = text.strip_prefix("```").and_then(|rest| rest.strip_suffix("```")) else {
        return text;
    };
    let body = body.trim_start_matches(['\r', '\n']);
    // A leading language tag (`cpp`, `python3`, `objective-c`) is not content.
    // It is only stripped when real content follows; a lone first line stays.
    let body = match body.find('\n') {
        Some(newline) => {
            let first = body[..newline].trim();
            let rest = &body[newline + 1..];
            let tag = !first.is_empty()
                && first.len() <= 32
                && first
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '#'))
                && !rest.trim().is_empty();
            if tag {
                rest
            } else {
                body
            }
        }
        None => body,
    };
    body.trim_end_matches(['\r', '\n'])
}

/// Extracts the first `{ ... }` span so fenced or prefixed JSON still parses.
fn json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    (end > start).then(|| &raw[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn analysis_json_is_parsed_with_question_and_flags() {
        let analysis = parse_analysis(
            r#"{"question":"What is the third letter of 'window'?","focus":true,"password":false,"note":""}"#,
        )
        .unwrap();
        assert_eq!(
            analysis.question.as_deref(),
            Some("What is the third letter of 'window'?")
        );
        assert!(analysis.focus);
        assert!(!analysis.password);
        assert!(analysis.note.is_empty());
    }

    #[test]
    fn missing_or_empty_question_becomes_none_and_flags_default_false() {
        let analysis = parse_analysis(r#"{"question":"   "}"#).unwrap();
        assert_eq!(analysis.question, None);
        assert!(!analysis.focus && !analysis.password);
        let analysis = parse_analysis(r#"{"question":null,"focus":false}"#).unwrap();
        assert_eq!(analysis.question, None);
    }

    #[test]
    fn fenced_and_prefixed_json_is_tolerated() {
        let fenced = "```json\n{\"question\":\"Q\",\"focus\":true}\n```";
        assert_eq!(parse_analysis(fenced).unwrap().question.as_deref(), Some("Q"));
        let prefixed = "Here is the analysis:\n{\"question\":\"Q2\",\"note\":\"ok\"}";
        let analysis = parse_analysis(prefixed).unwrap();
        assert_eq!(analysis.question.as_deref(), Some("Q2"));
        assert_eq!(analysis.note, "ok");
    }

    #[test]
    fn invalid_analyses_fail_explicitly() {
        assert!(parse_analysis("no json at all").is_err());
        assert!(parse_analysis("{\"question\":").is_err());
        assert!(parse_analysis("{\"question\": 42}").is_err());
        let oversized = format!(r#"{{"question":"{}"}}"#, "x".repeat(MAX_QUESTION_CHARS + 1));
        assert!(parse_analysis(&oversized).unwrap_err().contains("size limit"));
        let accepted = format!(r#"{{"question":"{}"}}"#, "x".repeat(MAX_QUESTION_CHARS));
        assert!(parse_analysis(&accepted).is_ok());
    }

    #[test]
    fn notes_are_truncated_to_the_advisory_limit() {
        let long = "n".repeat(MAX_NOTE_CHARS + 120);
        let analysis = parse_analysis(&format!(r#"{{"note":"{long}"}}"#)).unwrap();
        assert_eq!(analysis.note.chars().count(), MAX_NOTE_CHARS);
    }

    #[test]
    fn solutions_are_trimmed_and_stripped_of_one_fenced_block() {
        assert_eq!(clean_solution("  answer text \n"), "answer text");
        assert_eq!(clean_solution("```\nplain\n```"), "plain");
        assert_eq!(clean_solution("```cpp\nreturn 1;\n```"), "return 1;");
        assert_eq!(
            clean_solution("```objective-c\n[x doThing];\n```"),
            "[x doThing];"
        );
    }

    #[test]
    fn solution_cleanup_keeps_unfenced_code_and_empty_results() {
        assert_eq!(clean_solution("fi\n"), "fi");
        assert_eq!(clean_solution("```\n```"), "");
        assert_eq!(clean_solution("   \n "), "");
        assert_eq!(clean_solution("print(1)"), "print(1)");
    }
}
