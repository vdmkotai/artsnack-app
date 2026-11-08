//! Media URLs, the same ones the web and iOS apps use
//! (`packages/shared/media-url.ts`). Keep them identical: the thumbnail and
//! poster URLs are Cloudflare transformations billed once per unique URL, and
//! every client asking for the same URL is what keeps that to one per image.

use url::Url;

/// The fixed preview width every client uses.
pub const THUMB_WIDTH: u32 = 512;
/// The reference picker's preview width (the web's `thumbUrl(key, 256)`).
const SMALL_THUMB_WIDTH: u32 = 256;

#[derive(Clone, Debug)]
pub struct MediaUrls {
    /// The media CDN's origin, e.g. `https://media.example.com`, no trailing
    /// slash.
    origin: String,
}

impl MediaUrls {
    pub fn new(origin: &Url) -> Self {
        Self {
            origin: origin.as_str().trim_end_matches('/').to_string(),
        }
    }

    /// The original object.
    pub fn original(&self, key: &str) -> String {
        format!("{}/{}", self.origin, key)
    }

    /// A ~512 px WebP/JPEG preview of an image.
    pub fn thumb(&self, key: &str) -> String {
        format!(
            "{}/cdn-cgi/image/format=auto,quality=72,width={THUMB_WIDTH},fit=scale-down/{}",
            self.origin, key
        )
    }

    /// A ~256 px preview, for the reference picker's dense grid. The same URL
    /// as the web picker's, so an image is transformed once for both.
    pub fn thumb_small(&self, key: &str) -> String {
        format!(
            "{}/cdn-cgi/image/format=auto,quality=72,width={SMALL_THUMB_WIDTH},fit=scale-down/{}",
            self.origin, key
        )
    }

    /// A clip.
    pub fn video(&self, key: &str) -> String {
        self.original(key)
    }

    /// A still frame at 1 s, for grids that show clips as posters.
    pub fn video_poster(&self, key: &str) -> String {
        format!(
            "{}/cdn-cgi/media/mode=frame,time=1s,format=jpg,width={THUMB_WIDTH},fit=scale-down/{}",
            self.origin, key
        )
    }

    /// The media CDN's origin, no trailing slash.
    pub fn origin(&self) -> &str {
        &self.origin
    }

    /// Whether `url` is on our media origin (immutable objects; cached forever)
    /// rather than a third-party URL that may change. The origin must end at a
    /// path boundary: `https://media.example.com.evil.test/…` is not ours.
    pub fn is_own(&self, url: &str) -> bool {
        is_under(&self.origin, url)
    }

    /// The object key of an original's URL; `None` for a transformation or a
    /// third-party URL.
    pub fn key_of<'a>(&self, url: &'a str) -> Option<&'a str> {
        url.strip_prefix(&self.origin)?
            .strip_prefix('/')
            .filter(|key| !key.is_empty() && !key.starts_with("cdn-cgi/"))
    }
}

/// Whether `url` is `origin` itself or a path under it.
pub(crate) fn is_under(origin: &str, url: &str) -> bool {
    url.strip_prefix(origin)
        .is_some_and(|rest| rest.is_empty() || rest.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn match_the_web_app_byte_for_byte() {
        let urls = MediaUrls::new(&Url::parse("https://media.example.com/").unwrap());
        assert_eq!(
            urls.original("a/b.png"),
            "https://media.example.com/a/b.png"
        );
        assert_eq!(
            urls.thumb("a/b.png"),
            "https://media.example.com/cdn-cgi/image/format=auto,quality=72,width=512,fit=scale-down/a/b.png"
        );
        assert_eq!(
            urls.video_poster("v.mp4"),
            "https://media.example.com/cdn-cgi/media/mode=frame,time=1s,format=jpg,width=512,fit=scale-down/v.mp4"
        );
    }

    #[test]
    fn own_urls_end_at_a_path_boundary() {
        let urls = MediaUrls::new(&Url::parse("https://media.example.com/").unwrap());
        assert!(urls.is_own("https://media.example.com/a/b.png"));
        assert!(urls.is_own(&urls.thumb("a/b.png")));
        assert!(!urls.is_own("https://media.example.com.evil.test/a/b.png"));
        assert!(!urls.is_own("https://example.com/a/b.png"));
    }

    #[test]
    fn small_thumbnails_match_the_web_picker() {
        let urls = MediaUrls::new(&Url::parse("https://media.example.com").unwrap());
        assert_eq!(
            urls.thumb_small("a/b.png"),
            "https://media.example.com/cdn-cgi/image/format=auto,quality=72,width=256,fit=scale-down/a/b.png"
        );
    }
}
