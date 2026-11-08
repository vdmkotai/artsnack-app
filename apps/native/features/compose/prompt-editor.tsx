import * as Haptics from "expo-haptics";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useRef, useState } from "react";
import {
  Keyboard,
  LayoutAnimation,
  Pressable,
  Text,
  TextInput,
  View,
  type KeyboardEvent,
} from "react-native";

import { colors, TABULAR } from "@/theme/colors";

import { useComposerContext } from "./context";

/** Which of the two prompts is being written. */
export type PromptTarget = "prompt" | "negative";

/** The text's own metrics, needed in the layout arithmetic below as numbers. */
const PADDING_TOP = 14;
const LINE_HEIGHT = 24;

/**
 * The prompt, on a screen of its own.
 *
 * This exists because a prompt is long and a composer is crowded, and every attempt
 * to reconcile those two on one screen failed the same way — see `prompt-field.tsx`
 * for the three that were tried. Here the text is the only thing on screen, so the
 * `TextInput` can keep `scrollEnabled` and own the drag gesture without taking it
 * from a page that also wants it. Scrolling a nine-hundred-character prompt is then
 * just scrolling.
 *
 * A modal rather than a form sheet: the keyboard takes half the screen and a detent
 * would leave a text editor a few lines tall. Cancel and Save in the navigation bar
 * are what iOS puts there, and they mean it — the draft is local, so Cancel really
 * does discard and Save really is the commit. An editor that wrote through on every
 * keystroke would have no honest use for either word.
 */
export function PromptEditor() {
  const { field } = useLocalSearchParams<{ field?: PromptTarget }>();
  const target: PromptTarget = field === "negative" ? "negative" : "prompt";
  const { engine, api, local } = useComposerContext();

  /**
   * The negative prompt belongs to the self-hosted form and only to it — the hosted
   * providers take none. Routing to it with the other engine live would otherwise
   * write into a form nothing on screen is showing.
   */
  const isLocal = engine === "local";
  const negative = target === "negative" && isLocal;
  const current = negative
    ? local.form.negativePrompt
    : isLocal
      ? local.form.prompt
      : api.form.prompt;

  // Seeded once. Re-seeding from the form would fight the user mid-word if
  // anything else touched it while this was open.
  const [draft, setDraft] = useState(current);
  const input = useRef<TextInput>(null);

  // Focused from an effect rather than `autoFocus`: that is an accessibility lint
  // error and fires before the field has laid out inside a modal presentation.
  useEffect(() => {
    const timer = setTimeout(() => input.current?.focus(), 220);
    return () => clearTimeout(timer);
  }, []);

  /**
   * Committing on the way out is what makes the swipe-down safe.
   *
   * An iOS modal can always be dragged away, and a Save button does not stop that —
   * so with Save as the only commit, a flick down silently threw away however much
   * had just been typed, which on this screen is the whole point of the screen.
   *
   * Dismissing therefore *keeps* the text, which is also what the gesture means
   * everywhere else in iOS: it is leaving, not undoing. Cancel stays the way to
   * discard, and it says so — it is the one path that sets this flag.
   */
  const write = useRef<(() => void) | null>(null);
  write.current = () => {
    if (draft === current) return;
    if (negative) local.setForm({ negativePrompt: draft });
    else if (isLocal) local.setForm({ prompt: draft });
    else api.setForm({ prompt: draft });
  };

  const discarded = useRef(false);
  useEffect(() => {
    // On unmount, however the screen was left: Save, Cancel, or the drag.
    return () => {
      if (!discarded.current) write.current?.();
    };
  }, []);

  const save = () => {
    write.current?.();
    void Haptics.selectionAsync();
    router.back();
  };

  const cancel = () => {
    discarded.current = true;
    router.back();
  };

  const dirty = draft !== current;

  /**
   * How much of this screen the keyboard covers — which is its own height, and
   * which `KeyboardAvoidingView` cannot work out from inside a modal.
   *
   * KAV compares its own frame against the keyboard's position in the window, and
   * in a native modal those two are in different coordinate spaces. The card is
   * presented by a UIKit view controller, and react-native-screens reports only
   * its *size* back into the shadow tree — so every measurement React can make,
   * `measureInWindow` included, believes this screen starts at the top of the
   * window when it really starts below the card's gap and the navigation bar.
   * (On the new architecture `measureInWindow` is computed from the shadow tree,
   * not from UIKit, so it cannot see the difference either; correcting KAV with
   * `keyboardVerticalOffset` was tried first and measured zero.) KAV therefore
   * padded by about a hundred points too little, and the bottom of the text view
   * sat under the keys with nothing left to scroll — it had already reached the
   * end of its own box; the box was in the wrong place.
   *
   * What holds regardless of coordinate space is that a sheet is flush with the
   * bottom of the screen, so the keyboard covers exactly its own height of it.
   * That is the padding, and it needs no measurement at all. LayoutAnimation with
   * the keyboard's own curve and duration is what KAV does with its number, and
   * is why the shrink follows the keys up instead of snapping.
   */
  const [keyboard, setKeyboard] = useState(0);
  useEffect(() => {
    const follow = (event: KeyboardEvent) => {
      // The floor is RCTLayoutAnimation's, which rejects anything shorter.
      const duration = event.duration > 10 ? event.duration : 10;
      LayoutAnimation.configureNext({
        duration,
        update: { duration, type: LayoutAnimation.Types[event.easing] ?? "keyboard" },
      });
    };
    const shown = Keyboard.addListener("keyboardWillShow", (event) => {
      follow(event);
      setKeyboard(event.endCoordinates.height);
    });
    const hidden = Keyboard.addListener("keyboardWillHide", (event) => {
      follow(event);
      setKeyboard(0);
    });
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  /**
   * Room to scroll past the last line.
   *
   * A text view stops scrolling once its final line reaches the bottom of the box,
   * which with the keyboard up leaves the end of a long prompt an inch above the
   * keys — visible, but the worst place on the screen to type into. On iOS a
   * multiline `TextInput`'s `paddingBottom` becomes the text container's bottom
   * inset, and an inset is scrollable space: with enough of it the end of the
   * prompt can be dragged up to just under the title, which is where editing it
   * is comfortable.
   *
   * Only when there is something to scroll. Applied unconditionally it would let a
   * three-word prompt be dragged off the top of an otherwise empty screen.
   */
  const [viewport, setViewport] = useState(0);
  const [textHeight, setTextHeight] = useState(0);
  const room = viewport - PADDING_TOP;
  const tail = textHeight > room ? Math.max(0, room - LINE_HEIGHT * 2) : 0;

  return (
    <View style={{ flex: 1, paddingBottom: keyboard }}>
      <Stack.Screen
        options={{
          title: negative ? "Negative prompt" : "Prompt",
          headerLeft: () => <HeaderButton label="Cancel" onPress={cancel} />,
          headerRight: () => <HeaderButton label="Save" strong={dirty} onPress={save} />,
        }}
      />

      <TextInput
        ref={input}
        value={draft}
        onChangeText={setDraft}
        placeholder={
          negative ? "What to avoid — artefacts, styles, watermarks…" : "Describe what to make…"
        }
        placeholderTextColor={colors.labelQuaternary}
        multiline
        // True, unlike every earlier attempt: nothing else on this screen scrolls,
        // so there is no gesture to lose and no page to push off the bottom.
        scrollEnabled
        keyboardAppearance="dark"
        onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
        // The reported content size is the text container's, insets included — so
        // the tail has to come back off to leave the height of the text alone,
        // which is what decides whether a tail is wanted at all. Without that
        // subtraction the two chase each other and the padding flickers.
        onContentSizeChange={(event) =>
          setTextHeight(event.nativeEvent.contentSize.height - PADDING_TOP - tail)
        }
        style={{
          flex: 1,
          color: colors.label,
          fontSize: 17,
          lineHeight: LINE_HEIGHT,
          paddingHorizontal: 18,
          paddingTop: PADDING_TOP,
          paddingBottom: tail,
        }}
      />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          paddingHorizontal: 18,
          paddingVertical: 10,
          borderTopWidth: 1,
          borderTopColor: colors.separator,
          backgroundColor: colors.background,
        }}
      >
        <Text style={{ color: colors.labelTertiary, fontSize: 12.5, flex: 1, ...TABULAR }}>
          {draft.length.toLocaleString("en-US")} character{draft.length === 1 ? "" : "s"}
        </Text>
        {draft.length > 0 ? (
          <Pressable onPress={() => setDraft("")} hitSlop={10}>
            {({ pressed }) => (
              <Text
                style={{
                  color: colors.labelSecondary,
                  fontSize: 13.5,
                  fontWeight: "500",
                  opacity: pressed ? 0.6 : 1,
                }}
              >
                Clear
              </Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

/**
 * Save is emphasised only when there is something to save.
 *
 * A permanently bold Save on an untouched editor reads as an unfinished action —
 * the user looks for what they were meant to have done.
 */
function HeaderButton({
  label,
  strong,
  onPress,
}: {
  label: string;
  strong?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} hitSlop={10}>
      {({ pressed }) => (
        <Text
          style={{
            color: colors.label,
            fontSize: 16.5,
            fontWeight: strong ? "700" : "400",
            opacity: pressed ? 0.55 : 1,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}
