//! Which backend the app talks to.
//!
//! Nothing is built in. The four endpoints — the Convex deployment, the Clerk
//! instance's Frontend API, the web app (it hosts the sign-in handoff page)
//! and the media CDN — each come from the first of:
//!
//! 1. an environment variable when the app starts (`ARTSNACK_CONVEX_URL`, …);
//! 2. `config.json` in the app's Application Support folder;
//! 3. a default baked in at compile time from the same variable
//!    (`option_env!`), for a build made for one deployment.
//!
//! `ARTSNACK_ENV=dev` switches to the development profile: the `_DEV`
//! variables and the file's `"dev"` section. There the web app defaults to a
//! local `bun run dev` (`http://localhost:4000`) and the media CDN to the
//! production one.
//!
//! Whatever is missing or malformed, [`Environment::load`] reports it, and the
//! app shows a setup window instead of starting (`crate::setup`). All of these
//! are public values; the web bundle ships the same ones.

use std::{
    fmt,
    path::{Path, PathBuf},
};

use gpui_kit::Global;
use serde_json::Value;
use url::Url;

#[derive(Clone, Debug)]
pub struct Environment {
    pub name: &'static str,
    pub convex_url: String,
    pub clerk_frontend_api: Url,
    pub web_app: Url,
    pub media_origin: Url,
}

impl Global for Environment {}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    Production,
    Development,
}

impl Profile {
    /// `ARTSNACK_ENV`: `dev` or `development` for development, else production.
    fn from_var(value: Option<&str>) -> Self {
        match value {
            Some("dev") | Some("development") => Self::Development,
            _ => Self::Production,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Self::Production => "production",
            Self::Development => "development",
        }
    }
}

/// One endpoint: where it is read from, and what it is for.
#[derive(Debug)]
pub struct Setting {
    /// The environment variable (and compile-time default) in production.
    pub var: &'static str,
    /// …and in development.
    pub dev_var: &'static str,
    /// Its key in `config.json` (production at the top level, development
    /// under `"dev"`).
    pub key: &'static str,
    /// What it points at, for the setup window.
    pub role: &'static str,
    /// A placeholder value, for the setup window's example.
    pub example: &'static str,
    baked: Option<&'static str>,
    baked_dev: Option<&'static str>,
}

impl Setting {
    pub fn var_for(&self, profile: Profile) -> &'static str {
        match profile {
            Profile::Production => self.var,
            Profile::Development => self.dev_var,
        }
    }

    /// The compile-time default for `profile`, if this build has one.
    fn baked_for(&self, profile: Profile) -> Option<&'static str> {
        match profile {
            Profile::Production => self.baked,
            Profile::Development => self.baked_dev,
        }
    }
}

/// Positions in [`SETTINGS`] with a development fallback.
const WEB: usize = 2;
const MEDIA: usize = 3;

pub const SETTINGS: [Setting; 4] = [
    Setting {
        var: "ARTSNACK_CONVEX_URL",
        dev_var: "ARTSNACK_CONVEX_URL_DEV",
        key: "convexUrl",
        role: "the Convex deployment",
        example: "https://your-deployment.convex.cloud",
        baked: option_env!("ARTSNACK_CONVEX_URL"),
        baked_dev: option_env!("ARTSNACK_CONVEX_URL_DEV"),
    },
    Setting {
        var: "ARTSNACK_CLERK_FRONTEND_API",
        dev_var: "ARTSNACK_CLERK_FRONTEND_API_DEV",
        key: "clerkFrontendApi",
        role: "the Clerk instance's Frontend API",
        example: "https://clerk.example.com",
        baked: option_env!("ARTSNACK_CLERK_FRONTEND_API"),
        baked_dev: option_env!("ARTSNACK_CLERK_FRONTEND_API_DEV"),
    },
    Setting {
        var: "ARTSNACK_WEB_ORIGIN",
        dev_var: "ARTSNACK_WEB_ORIGIN_DEV",
        key: "webOrigin",
        role: "the web app, which hosts the sign-in handoff",
        example: "https://artsnack.example.com",
        baked: option_env!("ARTSNACK_WEB_ORIGIN"),
        baked_dev: option_env!("ARTSNACK_WEB_ORIGIN_DEV"),
    },
    Setting {
        var: "ARTSNACK_MEDIA_ORIGIN",
        dev_var: "ARTSNACK_MEDIA_ORIGIN_DEV",
        key: "mediaOrigin",
        role: "the media CDN",
        example: "https://media.example.com",
        baked: option_env!("ARTSNACK_MEDIA_ORIGIN"),
        baked_dev: option_env!("ARTSNACK_MEDIA_ORIGIN_DEV"),
    },
];

/// The development web app when nothing else is set: `bun run dev`.
const DEV_WEB_ORIGIN: &str = "http://localhost:4000";

/// What stops the app from starting, for the setup window and the log.
#[derive(Debug)]
pub struct ConfigError {
    pub profile: Profile,
    /// Where `config.json` is looked for, when there is a place for it.
    pub file: Option<PathBuf>,
    /// `config.json` exists but cannot be used.
    pub file_problem: Option<String>,
    /// Settings with no value anywhere.
    pub missing: Vec<&'static Setting>,
    /// Values that are not http(s) URLs, described.
    pub invalid: Vec<String>,
}

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "ArtSnack is not configured ({} profile)",
            self.profile.name()
        )?;
        if let Some(problem) = &self.file_problem {
            write!(f, "\n- {problem}")?;
        }
        for setting in &self.missing {
            write!(
                f,
                "\n- {} is not set ({})",
                setting.var_for(self.profile),
                setting.role
            )?;
        }
        for problem in &self.invalid {
            write!(f, "\n- {problem}")?;
        }
        Ok(())
    }
}

impl ConfigError {
    /// A `config.json` for this profile, with placeholders for what is missing.
    pub fn example_file(&self) -> String {
        let section: serde_json::Map<String, Value> = SETTINGS
            .iter()
            .map(|setting| (setting.key.to_string(), setting.example.into()))
            .collect();
        let file = match self.profile {
            Profile::Production => Value::Object(section),
            Profile::Development => serde_json::json!({ "dev": section }),
        };
        serde_json::to_string_pretty(&file).unwrap_or_default()
    }
}

impl Environment {
    /// Reads the configuration: the environment, then `config.json`, then the
    /// compile-time defaults.
    pub fn load() -> Result<Self, ConfigError> {
        let profile = Profile::from_var(std::env::var("ARTSNACK_ENV").ok().as_deref());
        let file = artsnack_settings::app_support_dir().map(|dir| dir.join("config.json"));
        let contents = file
            .as_deref()
            .map(read_config_file)
            .unwrap_or(Ok(Value::Null));
        resolve(
            profile,
            &|name| std::env::var(name).ok(),
            &Setting::baked_for,
            contents,
            file,
        )
    }
}

/// `config.json` as JSON; a missing file is `Null`, an unreadable or
/// malformed one a problem to show.
fn read_config_file(path: &Path) -> Result<Value, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&text)
            .map_err(|error| format!("{} is not valid JSON: {error}", path.display()))
            .and_then(|value| match value {
                Value::Object(_) => Ok(value),
                _ => Err(format!("{} must hold a JSON object", path.display())),
            }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(error) => Err(format!("{} could not be read: {error}", path.display())),
    }
}

/// A value and where it came from, for error messages.
struct Found {
    value: String,
    source: String,
}

fn resolve(
    profile: Profile,
    var: &dyn Fn(&str) -> Option<String>,
    baked: &dyn Fn(&Setting, Profile) -> Option<&'static str>,
    file: Result<Value, String>,
    path: Option<PathBuf>,
) -> Result<Environment, ConfigError> {
    let (file, file_problem) = match file {
        Ok(value) => (value, None),
        Err(problem) => (Value::Null, Some(problem)),
    };
    let mut invalid = Vec::new();
    let file_name = path
        .as_deref()
        .and_then(Path::file_name)
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "config.json".into());

    // One profile's lookup: the variable, the file's section, the baked value.
    let lookup = |setting: &Setting, profile: Profile, invalid: &mut Vec<String>| {
        let name = setting.var_for(profile);
        if let Some(value) = var(name).filter(|value| !value.trim().is_empty()) {
            return Some(Found {
                value,
                source: name.to_string(),
            });
        }
        let section = match profile {
            Profile::Production => Some(&file),
            Profile::Development => file.get("dev"),
        };
        match section.and_then(|section| section.get(setting.key)) {
            Some(Value::String(value)) if !value.trim().is_empty() => {
                let prefix = if profile == Profile::Development {
                    "dev."
                } else {
                    ""
                };
                return Some(Found {
                    value: value.clone(),
                    source: format!("{prefix}{} in {file_name}", setting.key),
                });
            }
            Some(Value::String(_)) | Some(Value::Null) | None => {}
            Some(_) => invalid.push(format!("{} in {file_name} must be a string", setting.key)),
        }
        baked(setting, profile)
            .filter(|value| !value.trim().is_empty())
            .map(|value| Found {
                value: value.to_string(),
                source: format!("{name} (built in)"),
            })
    };

    let mut missing = Vec::new();
    let mut urls: Vec<Option<Url>> = Vec::with_capacity(SETTINGS.len());
    for (ix, setting) in SETTINGS.iter().enumerate() {
        let found = lookup(setting, profile, &mut invalid).or_else(|| match (profile, ix) {
            (Profile::Development, WEB) => Some(Found {
                value: DEV_WEB_ORIGIN.into(),
                source: "the development default".into(),
            }),
            (Profile::Development, MEDIA) => lookup(setting, Profile::Production, &mut invalid),
            _ => None,
        });
        let Some(found) = found else {
            missing.push(setting);
            urls.push(None);
            continue;
        };
        match parse_endpoint(found.value.trim()) {
            Ok(url) => urls.push(Some(url)),
            Err(reason) => {
                invalid.push(format!("{} is {reason}: {}", found.source, found.value));
                urls.push(None);
            }
        }
    }

    if file_problem.is_some() || !missing.is_empty() || !invalid.is_empty() {
        return Err(ConfigError {
            profile,
            file: path,
            file_problem,
            missing,
            invalid,
        });
    }
    let urls: Vec<Url> = urls.into_iter().flatten().collect();
    let [convex, clerk, web, media] = <[Url; 4]>::try_from(urls).expect("every endpoint resolved");
    Ok(Environment {
        name: profile.name(),
        // The Convex client takes the deployment URL as written, minus a
        // trailing slash `Url` would add to a bare origin.
        convex_url: convex.as_str().trim_end_matches('/').to_string(),
        clerk_frontend_api: clerk,
        web_app: web,
        media_origin: media,
    })
}

/// An endpoint must be an absolute http(s) URL with a host.
fn parse_endpoint(raw: &str) -> Result<Url, &'static str> {
    let url = Url::parse(raw).map_err(|_| "not a URL")?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("not an http(s) URL");
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    /// No compile-time defaults, whatever this build was compiled with.
    const NONE: fn(&Setting, Profile) -> Option<&'static str> = |_, _| None;

    const ALL: [(&str, &str); 4] = [
        (
            "ARTSNACK_CONVEX_URL",
            "https://your-deployment.convex.cloud",
        ),
        ("ARTSNACK_CLERK_FRONTEND_API", "https://clerk.example.com"),
        ("ARTSNACK_WEB_ORIGIN", "https://artsnack.example.com"),
        ("ARTSNACK_MEDIA_ORIGIN", "https://media.example.com"),
    ];

    #[test]
    fn reads_every_endpoint_from_the_environment() {
        let environment = resolve(
            Profile::Production,
            &env(&ALL),
            &NONE,
            Ok(Value::Null),
            None,
        )
        .unwrap();
        assert_eq!(environment.name, "production");
        assert_eq!(
            environment.convex_url,
            "https://your-deployment.convex.cloud"
        );
        assert_eq!(
            environment.clerk_frontend_api.as_str(),
            "https://clerk.example.com/"
        );
        assert_eq!(
            environment.web_app.as_str(),
            "https://artsnack.example.com/"
        );
        assert_eq!(
            environment.media_origin.as_str(),
            "https://media.example.com/"
        );
    }

    #[test]
    fn nothing_set_lists_everything_missing() {
        let error =
            resolve(Profile::Production, &env(&[]), &NONE, Ok(Value::Null), None).unwrap_err();
        let missing: Vec<&str> = error.missing.iter().map(|setting| setting.var).collect();
        assert_eq!(
            missing,
            [
                "ARTSNACK_CONVEX_URL",
                "ARTSNACK_CLERK_FRONTEND_API",
                "ARTSNACK_WEB_ORIGIN",
                "ARTSNACK_MEDIA_ORIGIN"
            ]
        );
        assert!(error.to_string().contains("ARTSNACK_CONVEX_URL is not set"));
    }

    #[test]
    fn compile_time_defaults_come_last() {
        let baked = |setting: &Setting, _: Profile| {
            ALL.iter()
                .find(|(name, _)| *name == setting.var)
                .map(|(_, value)| *value)
        };
        let vars = env(&[("ARTSNACK_WEB_ORIGIN", "http://localhost:4000")]);
        let environment =
            resolve(Profile::Production, &vars, &baked, Ok(Value::Null), None).unwrap();
        assert_eq!(environment.web_app.as_str(), "http://localhost:4000/");
        assert_eq!(
            environment.media_origin.as_str(),
            "https://media.example.com/"
        );
    }

    #[test]
    fn the_file_fills_in_what_the_environment_leaves_out() {
        let file = serde_json::json!({
            "clerkFrontendApi": "https://clerk.example.com",
            "webOrigin": "https://artsnack.example.com",
            "mediaOrigin": "https://ignored.example.com",
        });
        let vars = env(&[
            (
                "ARTSNACK_CONVEX_URL",
                "https://your-deployment.convex.cloud",
            ),
            ("ARTSNACK_MEDIA_ORIGIN", "https://media.example.com"),
        ]);
        let environment = resolve(Profile::Production, &vars, &NONE, Ok(file), None).unwrap();
        assert_eq!(
            environment.web_app.as_str(),
            "https://artsnack.example.com/"
        );
        assert_eq!(
            environment.media_origin.as_str(),
            "https://media.example.com/"
        );
    }

    #[test]
    fn development_reads_its_own_settings_with_local_defaults() {
        let file = serde_json::json!({
            "mediaOrigin": "https://media.example.com",
            "dev": { "clerkFrontendApi": "https://clerk-dev.example.com" },
        });
        let vars = env(&[(
            "ARTSNACK_CONVEX_URL_DEV",
            "https://your-dev-deployment.convex.cloud",
        )]);
        let environment = resolve(Profile::Development, &vars, &NONE, Ok(file), None).unwrap();
        assert_eq!(environment.name, "development");
        assert_eq!(
            environment.convex_url,
            "https://your-dev-deployment.convex.cloud"
        );
        assert_eq!(
            environment.clerk_frontend_api.as_str(),
            "https://clerk-dev.example.com/"
        );
        assert_eq!(environment.web_app.as_str(), "http://localhost:4000/");
        assert_eq!(
            environment.media_origin.as_str(),
            "https://media.example.com/"
        );
    }

    #[test]
    fn development_never_falls_back_to_the_production_backend() {
        let error = resolve(
            Profile::Development,
            &env(&ALL),
            &NONE,
            Ok(Value::Null),
            None,
        )
        .unwrap_err();
        let missing: Vec<&str> = error
            .missing
            .iter()
            .map(|setting| setting.dev_var)
            .collect();
        assert_eq!(
            missing,
            ["ARTSNACK_CONVEX_URL_DEV", "ARTSNACK_CLERK_FRONTEND_API_DEV"]
        );
    }

    #[test]
    fn malformed_values_and_files_are_reported() {
        let mut vars = ALL.to_vec();
        vars[2] = ("ARTSNACK_WEB_ORIGIN", "artsnack.example.com");
        vars[3] = ("ARTSNACK_MEDIA_ORIGIN", "ftp://media.example.com");
        let error = resolve(
            Profile::Production,
            &env(&vars),
            &NONE,
            Ok(Value::Null),
            None,
        )
        .unwrap_err();
        assert_eq!(error.invalid.len(), 2, "{:?}", error.invalid);
        assert!(error.invalid[0].starts_with("ARTSNACK_WEB_ORIGIN"));

        let broken = resolve(
            Profile::Production,
            &env(&ALL),
            &NONE,
            Err("config.json is not valid JSON".into()),
            None,
        )
        .unwrap_err();
        assert!(broken.file_problem.is_some());
    }

    #[test]
    fn the_example_file_uses_placeholders_only() {
        let error = resolve(
            Profile::Development,
            &env(&[]),
            &NONE,
            Ok(Value::Null),
            None,
        )
        .unwrap_err();
        let example: Value = serde_json::from_str(&error.example_file()).unwrap();
        assert_eq!(
            example["dev"]["convexUrl"],
            "https://your-deployment.convex.cloud"
        );
        assert_eq!(example["dev"]["mediaOrigin"], "https://media.example.com");
    }
}
