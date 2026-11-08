//! The status poll behind the backend panels (the web's `usePolling`).
//!
//! - Self-scheduling: the next wait starts when an answer arrives, so a slow
//!   provider can never stack requests, and a key that changes while a
//!   request is out waits for that answer instead of sending a second
//!   alongside it.
//! - A new key polls at once. The panels put the backend's state in the key,
//!   so every transition re-reads the provider immediately and then settles
//!   into the pace that state calls for.
//! - While the window is not visible (minimised, fully covered) no timer runs;
//!   when it shows again the poll fires at once if its wait ran out meanwhile,
//!   or waits out the rest.
//! - [`Poller::poll_now`] (a Refresh button) runs the next poll at once, or
//!   right after the one that is out — never a second request beside it.
//!
//! The loop belongs to its owner's entity: it stops when the owner is dropped,
//! which for a dialog's panel is when the dialog closes.

use std::{
    pin::pin,
    time::{Duration, Instant},
};

use futures::{StreamExt as _, channel::mpsc, future};
use gpui_kit::{Context, Subscription, Task, Window};

/// Every few seconds while a backend is on its way somewhere (booting,
/// starting, being destroyed)…
pub const FAST_POLL: Duration = Duration::from_secs(5);
/// …and about once a minute while it is not. A ready or stopped pod changes
/// only when someone acts on it, and the panels' own buttons write their
/// result without waiting for a poll.
pub const SLOW_POLL: Duration = Duration::from_secs(60);

/// When the next poll is due. Kept apart from the loop so it can be tested.
#[derive(Debug)]
struct Schedule<K> {
    key: Option<K>,
    /// The key the last finished poll was for.
    polled: Option<K>,
    due: Option<Instant>,
    visible: bool,
    /// Poll at once, whatever the wait (set by `poll_now`, cleared when a
    /// poll starts).
    immediate: bool,
}

#[derive(Debug, PartialEq)]
enum Step<K> {
    Poll(K),
    Wait(Duration),
    /// Nothing to poll, or the window is hidden: wait to be woken.
    Idle,
}

impl<K: Clone + PartialEq> Schedule<K> {
    fn step(&self, now: Instant) -> Step<K> {
        let Some(key) = self.key.as_ref().filter(|_| self.visible) else {
            return Step::Idle;
        };
        if self.immediate || self.polled.as_ref() != Some(key) {
            return Step::Poll(key.clone());
        }
        match self.due {
            Some(due) if due > now => Step::Wait(due - now),
            _ => Step::Poll(key.clone()),
        }
    }

    /// Returns whether anything changed.
    fn set_key(&mut self, key: Option<K>) -> bool {
        if self.key == key {
            return false;
        }
        if key.is_none() {
            // Coming back to the same key later is a fresh start, as a
            // remounted web panel is: it polls at once.
            self.polled = None;
            self.due = None;
        }
        self.key = key;
        true
    }

    fn started(&mut self) {
        self.immediate = false;
    }

    fn finished(&mut self, key: K, wait: Duration, now: Instant) {
        self.polled = Some(key);
        self.due = Some(now + wait);
    }
}

/// Polls while it has a key. The owner keeps it in a field, sets the key as
/// its data changes, and answers each poll with the wait before the next.
pub struct Poller<K> {
    schedule: Schedule<K>,
    wake: mpsc::UnboundedSender<()>,
    _task: Task<()>,
    _visibility: Subscription,
}

enum Next<K> {
    Poll(K, Task<Duration>),
    Wait(Option<Duration>),
}

impl<K: Clone + PartialEq + 'static> Poller<K> {
    /// `poller` finds this poller in its owner. `poll` sends one request for a
    /// key and resolves to how long to wait before the next; it should check
    /// [`Self::is_current`] before applying an answer to the screen.
    pub fn new<T: 'static>(
        window: &mut Window,
        cx: &mut Context<T>,
        poller: fn(&mut T) -> &mut Poller<K>,
        poll: fn(&mut T, K, &mut Context<T>) -> Task<Duration>,
    ) -> Self {
        let (wake, mut woken) = mpsc::unbounded::<()>();
        let task = cx.spawn(async move |this, cx| {
            loop {
                let next = this.update(cx, |this, cx| {
                    match poller(this).schedule.step(Instant::now()) {
                        Step::Poll(key) => {
                            poller(this).schedule.started();
                            Next::Poll(key.clone(), poll(this, key, cx))
                        }
                        Step::Wait(wait) => Next::Wait(Some(wait)),
                        Step::Idle => Next::Wait(None),
                    }
                });
                let Ok(next) = next else { return };
                match next {
                    Next::Poll(key, request) => {
                        let wait = request.await;
                        let recorded = this.update(cx, |this, _| {
                            poller(this).schedule.finished(key, wait, Instant::now())
                        });
                        if recorded.is_err() {
                            return;
                        }
                    }
                    Next::Wait(Some(wait)) => {
                        let timer = pin!(cx.background_executor().timer(wait));
                        if let future::Either::Right((None, _)) =
                            future::select(timer, woken.next()).await
                        {
                            return;
                        }
                    }
                    Next::Wait(None) => {
                        if woken.next().await.is_none() {
                            return;
                        }
                    }
                }
            }
        });
        let visibility = cx.observe_window_visibility(window, move |this, visibility, _, _| {
            poller(this).set_visible(visibility.is_visible());
        });
        Self {
            schedule: Schedule {
                key: None,
                polled: None,
                due: None,
                visible: window.is_visible(),
                immediate: false,
            },
            wake,
            _task: task,
            _visibility: visibility,
        }
    }

    /// What to poll from now on; `None` stops polling.
    pub fn set_key(&mut self, key: Option<K>) {
        if self.schedule.set_key(key) {
            let _ = self.wake.unbounded_send(());
        }
    }

    /// Polls at once if nothing is out, else as soon as the request that is
    /// out has answered. Does nothing without a key.
    pub fn poll_now(&mut self) {
        if self.schedule.key.is_some() {
            self.schedule.immediate = true;
            let _ = self.wake.unbounded_send(());
        }
    }

    /// Whether there is anything to poll.
    pub fn has_key(&self) -> bool {
        self.schedule.key.is_some()
    }

    /// Whether an answer for `key` is still the one the screen wants.
    pub fn is_current(&self, key: &K) -> bool {
        self.schedule.key.as_ref() == Some(key)
    }

    fn set_visible(&mut self, visible: bool) {
        if self.schedule.visible != visible {
            self.schedule.visible = visible;
            let _ = self.wake.unbounded_send(());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schedule() -> Schedule<&'static str> {
        Schedule {
            key: None,
            polled: None,
            due: None,
            visible: true,
            immediate: false,
        }
    }

    #[test]
    fn a_new_key_polls_at_once_then_waits() {
        let now = Instant::now();
        let mut schedule = schedule();
        assert_eq!(schedule.step(now), Step::Idle);
        schedule.set_key(Some("pod:loading"));
        assert_eq!(schedule.step(now), Step::Poll("pod:loading"));
        schedule.finished("pod:loading", FAST_POLL, now);
        assert_eq!(schedule.step(now), Step::Wait(FAST_POLL));
        assert_eq!(
            schedule.step(now + FAST_POLL),
            Step::Poll("pod:loading"),
            "due exactly now"
        );
        // A state change re-reads at once rather than waiting out the old pace.
        schedule.set_key(Some("pod:ready"));
        assert_eq!(schedule.step(now), Step::Poll("pod:ready"));
    }

    #[test]
    fn a_hidden_window_waits_and_resumes_when_due() {
        let now = Instant::now();
        let mut schedule = schedule();
        schedule.set_key(Some("pod:ready"));
        schedule.finished("pod:ready", SLOW_POLL, now);
        schedule.visible = false;
        assert_eq!(schedule.step(now + SLOW_POLL * 2), Step::Idle);
        schedule.visible = true;
        assert_eq!(schedule.step(now + SLOW_POLL * 2), Step::Poll("pod:ready"));
        assert_eq!(
            schedule.step(now + Duration::from_secs(10)),
            Step::Wait(SLOW_POLL - Duration::from_secs(10))
        );
    }

    #[test]
    fn poll_now_runs_the_next_poll_at_once_even_after_one_that_was_out() {
        let now = Instant::now();
        let mut schedule = schedule();
        schedule.set_key(Some("pod:ready"));
        assert_eq!(schedule.step(now), Step::Poll("pod:ready"));
        schedule.started();
        // Refresh pressed while that poll is out…
        schedule.immediate = true;
        // …and it answers with a long wait: the next poll still goes at once.
        schedule.finished("pod:ready", SLOW_POLL, now);
        assert_eq!(schedule.step(now), Step::Poll("pod:ready"));
        schedule.started();
        schedule.finished("pod:ready", SLOW_POLL, now);
        assert_eq!(schedule.step(now), Step::Wait(SLOW_POLL));
    }

    #[test]
    fn dropping_the_key_starts_afresh() {
        let now = Instant::now();
        let mut schedule = schedule();
        schedule.set_key(Some("pod:ready"));
        schedule.finished("pod:ready", SLOW_POLL, now);
        assert!(schedule.set_key(None));
        assert!(!schedule.set_key(None));
        schedule.set_key(Some("pod:ready"));
        assert_eq!(schedule.step(now), Step::Poll("pod:ready"));
    }
}
