import { useAction, useQuery } from "convex/react";
import { router } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ScrollView } from "react-native";

import { api } from "@/convex/_generated/api";
import { useComposerContext } from "@/features/compose/context";
import { Row, Section } from "@/features/compose/rows";
import { API_MODEL_IDS, getApiModel, PROVIDER_LABELS, PROVIDER_ORDER } from "@/lib/api-models";
import { formatUsd } from "@/lib/api-pricing";
import { ATLAS_MODELS, getAtlasModel, isAtlasModelId, type AtlasModel } from "@/lib/atlas-models";
import { withAtlasModel } from "@/lib/normalize-form";

/**
 * Your own GPU first, then the providers and the models each offers.
 *
 * Provider before model is the same order the web switcher uses, and for the same
 * reason: the same Seedream is reachable through two providers at different
 * prices and with different limits, so which one runs it is a choice rather than
 * a detail.
 *
 * Atlas is the exception to "list the models", because it has 264 of them. What
 * it lists instead is the ones this account has starred — the handful you
 * actually use, one tap away — with the catalogue behind a row that opens a
 * searchable screen. Starring happens there; this is where it pays off.
 *
 * Picking here switches what the Create tab renders — it does not push a screen.
 */
export default function EngineSheet() {
  const { api: composer, engine, setEngine } = useComposerContext();

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 40 }}
    >
      <Section title="YOUR OWN GPU">
        <Row
          label="Local — ComfyUI on RunPod"
          detail="Your checkpoints and LoRA chain. No per-image cost."
          selected={engine === "local"}
          accessory="none"
          onPress={() => {
            setEngine("local");
            router.back();
          }}
        />
      </Section>

      {PROVIDER_ORDER.map((provider) => {
        const models = API_MODEL_IDS.filter((id) => getApiModel(id).provider === provider);
        if (models.length === 0) return null;
        return (
          <Section key={provider} title={PROVIDER_LABELS[provider].toUpperCase()}>
            {models.map((id) => (
              <Row
                key={id}
                label={getApiModel(id).label}
                selected={
                  engine === "api" &&
                  composer.form.provider !== "atlas" &&
                  composer.form.model === id
                }
                accessory="none"
                onPress={() => {
                  // `provider` moves with the model, or the composer highlights
                  // one provider while the button runs another.
                  composer.setForm({ model: id, provider });
                  setEngine("api");
                  router.back();
                }}
              />
            ))}
          </Section>
        );
      })}

      <AtlasSection />
    </ScrollView>
  );
}

function AtlasSection() {
  const { api: composer, engine, setEngine } = useComposerContext();
  const favoriteIds = useQuery(api.atlasFavorites.list);
  const balance = useAtlasBalance();

  /**
   * Starred models that still exist.
   *
   * The catalogue is regenerated from a live vendor, so a starred id can outlive
   * the model it names. Dropping those is right — the row would otherwise render
   * from a model that is not there — and the record stays in Convex in case a
   * later sync brings it back.
   */
  const starred = useMemo(
    () => (favoriteIds ?? []).filter(isAtlasModelId).map(getAtlasModel),
    [favoriteIds],
  );

  const select = (model: AtlasModel) => {
    // Sets provider, media type and the right model slot together: the starred
    // list mixes image and video, so a tap has to be able to move the media
    // type or the composer is left pointing a video model at an image.
    composer.setForm(withAtlasModel(composer.form, model));
    setEngine("api");
    router.back();
  };

  const isActive = (model: AtlasModel) =>
    engine === "api" &&
    composer.form.provider === "atlas" &&
    (model.media === "video"
      ? composer.form.atlasVideoModel === model.id
      : composer.form.atlasImageModel === model.id);

  return (
    <Section
      title="ATLAS CLOUD"
      footer={balance === null ? undefined : `${formatUsd(balance)} left on the account`}
    >
      {starred.map((model) => (
        <Row
          key={model.id}
          label={model.label}
          detail={model.media === "video" ? "Video" : "Image"}
          value={
            model.basePrice === null
              ? undefined
              : `$${model.basePrice}${model.media === "video" ? "/s" : ""}`
          }
          selected={isActive(model)}
          accessory="none"
          onPress={() => select(model)}
        />
      ))}
      <Row
        label={starred.length === 0 ? "Choose a model" : `All ${ATLAS_MODELS.length} models`}
        detail={starred.length === 0 ? "Star the ones you use and they appear here." : undefined}
        onPress={() => router.push("/atlas-models")}
      />
    </Section>
  );
}

/**
 * What is left in the Atlas account.
 *
 * Atlas spends a prepaid balance, so the number that matters while choosing a
 * model is the remainder — the failure this prevents is a batch dying on a 402
 * halfway through. An action rather than a query, because reading it means
 * calling the vendor, so it is fetched once when this sheet opens.
 *
 * Null when no key is configured or the vendor would not answer: saying nothing
 * beats a zero, which reads as "you are out of money".
 */
function useAtlasBalance(): number | null {
  const getBalance = useAction(api.atlasBalance.get);
  const [available, setAvailable] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getBalance({})
      .then((result) => {
        if (!cancelled) setAvailable(result?.available ?? null);
      })
      .catch(() => {
        if (!cancelled) setAvailable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [getBalance]);

  return available;
}
