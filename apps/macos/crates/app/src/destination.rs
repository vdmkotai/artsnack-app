//! The top-level destinations, in tab-bar order.
//!
//! The web app's tab bar, minus Models.

use gpui_kit::{SharedString, assets::IconName};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Destination {
    Generate,
    History,
    Gallery,
    Favorites,
    Prompts,
    Enhance,
    Search,
    Settings,
}

impl Destination {
    /// The tabs on the left of the title bar, in order. Cmd-1 … Cmd-6 follow it.
    pub const TABS: [Self; 6] = [
        Self::Generate,
        Self::History,
        Self::Gallery,
        Self::Favorites,
        Self::Prompts,
        Self::Enhance,
    ];

    /// Every destination, in Cmd-number order: the tabs, then Search, Settings.
    pub const ALL: [Self; 8] = [
        Self::Generate,
        Self::History,
        Self::Gallery,
        Self::Favorites,
        Self::Prompts,
        Self::Enhance,
        Self::Search,
        Self::Settings,
    ];

    pub fn label(self) -> SharedString {
        match self {
            Self::Generate => "Generate",
            Self::History => "History",
            Self::Gallery => "Gallery",
            Self::Favorites => "Favorites",
            Self::Prompts => "Prompts",
            Self::Enhance => "Enhance",
            Self::Search => "Search",
            Self::Settings => "Settings",
        }
        .into()
    }

    /// The same Lucide icons as the web tab bar.
    pub fn icon(self) -> IconName {
        match self {
            Self::Generate => IconName::Wand,
            Self::History => IconName::Clock,
            Self::Gallery => IconName::Images,
            Self::Favorites => IconName::Heart,
            Self::Prompts => IconName::Library,
            Self::Enhance => IconName::Zap,
            Self::Search => IconName::Search,
            Self::Settings => IconName::Settings,
        }
    }

    /// The path of the equivalent page on the web app.
    pub fn web_path(self) -> &'static str {
        match self {
            Self::Generate => "/generate",
            Self::History => "/history",
            Self::Gallery => "/gallery",
            Self::Favorites => "/favorites",
            Self::Prompts => "/prompts",
            Self::Enhance => "/enhance",
            Self::Search => "/search",
            Self::Settings => "/settings",
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            Self::Generate => "generate",
            Self::History => "history",
            Self::Gallery => "gallery",
            Self::Favorites => "favorites",
            Self::Prompts => "prompts",
            Self::Enhance => "enhance",
            Self::Search => "search",
            Self::Settings => "settings",
        }
    }
}
