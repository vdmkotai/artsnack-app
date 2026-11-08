import { useMutation, useQuery } from "convex/react";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Pressable, ScrollView, Text, View } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { failureCopy, localFailureKind, type FailureOffer } from "@/features/feed/failure";
import { PromptBlock } from "@/features/ui/prompt-block";
import { describeFailure } from "@/lib/failure-message";
import { colors, CONTINUOUS } from "@/theme/colors";

/**
 * Why one generation failed, and what can be done about it.
 *
 * A form sheet rather than a push: this is a detour from the grid, and the grid
 * should still be visible behind it.
 */
export default function FailureSheet() {
  const params = useLocalSearchParams<{ id: string; source: "local" | "api" | "video" }>();
  const isLocal = params.source === "local";
  // A self-hosted clip is its own table. Before it had a branch here, a failed
  // one opened this sheet and asked `grokGenerations` for a `videos` id — a
  // cross-table id `v.id` rejects outright, so the sheet stayed blank.
  const isVideo = params.source === "video";

  const hosted = useQuery(api.grokGenerations.get, isLocal || isVideo ? "skip" : { id: params.id });
  const local = useQuery(
    api.generations.getById,
    isLocal ? { id: params.id as Id<"generations"> } : "skip",
  );
  const video = useQuery(api.videos.getById, isVideo ? { id: params.id } : "skip");

  const removeHosted = useMutation(api.grokGenerations.remove);
  const removeLocal = useMutation(api.generations.remove);
  const removeVideo = useMutation(api.videos.deleteVideo);

  const [showRaw, setShowRaw] = useState(false);

  const row = isLocal ? local : isVideo ? video : hosted;
  // Self-hosted rows carry no `errorKind` — the classifier exists for vendor
  // failures — so theirs is read out of the message. It used to be hard-coded to
  // "timeout", which described a minority of them and misdirected the rest.
  // A clip runs on the same pod as a self-hosted image and carries no
  // `errorKind` either, so it reads its class out of the message the same way.
  const kind = isLocal
    ? localFailureKind(local?.error ?? undefined)
    : isVideo
      ? localFailureKind(video?.error ?? undefined)
      : (hosted?.errorKind ?? undefined);
  const copy = failureCopy(kind);
  const message = describeFailure(row?.error ?? undefined);

  // What was asked for. A failed generation is usually retried by hand somewhere
  // else, and retyping the prompt is the whole cost of doing that.
  const prompt = isLocal
    ? local?.formState.prompt
    : isVideo
      ? video?.settings.prompt
      : hosted?.prompt;
  const negativePrompt = isLocal
    ? local?.formState.negativePrompt
    : isVideo
      ? video?.settings.negativePrompt
      : undefined;

  const remove = async () => {
    // Reported rather than swallowed: without this, a delete that failed left the
    // screen exactly as it was — no navigation, no message — which is
    // indistinguishable from a button that does nothing.
    try {
      if (isLocal) await removeLocal({ id: params.id as Id<"generations"> });
      else if (isVideo) await removeVideo({ id: params.id });
      else await removeHosted({ id: params.id as Id<"grokGenerations"> });
    } catch (cause) {
      Alert.alert(
        "Could not delete",
        cause instanceof Error ? cause.message : "The row could not be removed.",
      );
      return;
    }
    router.back();
  };

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={{ padding: 16, paddingBottom: 40 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colors.danger }} />
        <Text style={{ color: colors.label, fontSize: 20, fontWeight: "700", letterSpacing: -0.4 }}>
          {copy.title}
        </Text>
      </View>

      <Text style={{ color: colors.labelSecondary, fontSize: 15.5, lineHeight: 22 }}>
        {copy.detail}
      </Text>

      {message.summary ? (
        <View
          style={{
            marginTop: 16,
            backgroundColor: colors.surface,
            borderRadius: 14,
            padding: 14,
            ...CONTINUOUS,
          }}
        >
          <Text
            style={{
              color: colors.labelTertiary,
              fontSize: 11,
              fontWeight: "600",
              letterSpacing: 0.6,
              marginBottom: 6,
            }}
          >
            WHAT THE PROVIDER SAID
          </Text>
          <Text style={{ color: colors.labelSecondary, fontSize: 14, lineHeight: 20 }}>
            {showRaw ? message.full : message.summary}
          </Text>
          {message.hasMore ? (
            <Pressable onPress={() => setShowRaw((value) => !value)} style={{ marginTop: 10 }}>
              <Text style={{ color: colors.label, fontSize: 14 }}>
                {showRaw ? "Show less" : "Show raw response"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}

      {prompt ? (
        <View style={{ marginTop: 18, gap: 14 }}>
          <PromptBlock label="PROMPT" text={prompt} />
          {negativePrompt && negativePrompt.trim().length > 0 ? (
            <PromptBlock label="NEGATIVE PROMPT" text={negativePrompt} tone="muted" />
          ) : null}
        </View>
      ) : null}

      <View style={{ marginTop: 18, gap: 1, borderRadius: 14, overflow: "hidden", ...CONTINUOUS }}>
        {copy.offers.map((offer) => (
          <Offer key={offer} offer={offer} />
        ))}
      </View>

      <Pressable
        onPress={() =>
          Alert.alert("Delete this generation?", undefined, [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => void remove() },
          ])
        }
        style={{
          marginTop: 18,
          backgroundColor: colors.surface,
          borderRadius: 14,
          paddingVertical: 13,
          alignItems: "center",
          ...CONTINUOUS,
        }}
      >
        <Text style={{ color: colors.danger, fontSize: 16.5 }}>Delete</Text>
      </Pressable>
    </ScrollView>
  );
}

const OFFER_LABEL: Record<FailureOffer, string> = {
  retry: "Try again",
  "try-grok": "Try on Grok Imagine",
  edit: "Edit and retry",
  "fix-provider": "Open provider settings",
};

/**
 * Offers are rendered but not yet wired: retry and edit both need the composer,
 * which lands in phase 4. Showing them disabled would be dishonest, so they say
 * what they will do and report that they cannot yet.
 */
function Offer({ offer }: { offer: FailureOffer }) {
  return (
    <Pressable
      onPress={() => Alert.alert(OFFER_LABEL[offer], "Available once the composer ships.")}
      style={{ backgroundColor: colors.surface, paddingVertical: 13, paddingHorizontal: 15 }}
    >
      <Text style={{ color: colors.label, fontSize: 16.5 }}>{OFFER_LABEL[offer]}</Text>
    </Pressable>
  );
}
