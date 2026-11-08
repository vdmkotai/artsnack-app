import { router, Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView } from "react-native";
import { BackendManager } from "@/features/tools/backend-manager";
import { Accounts } from "@/features/tools/accounts";
import { Recipes } from "@/features/tools/recipes";
import { Action } from "@/features/tools/controls";
import { EnhanceImage } from "@/features/tools/enhance-image";

const sections = {
  backend: "Self-hosted backend",
  enhance: "Enhance image",
  recipes: "Enhance prompt and recipes",
  accounts: "Connected accounts",
} as const;
type Section = keyof typeof sections;
export default function ToolsScreen() {
  const params = useLocalSearchParams<{
    section?: string;
    sourceKey?: string;
    sourceGenerationId?: string;
  }>();
  const [section, setSection] = useState<Section | null>(() =>
    params.section && params.section in sections ? (params.section as Section) : null,
  );
  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: 17, paddingBottom: 50, gap: 12 }}
    >
      <Stack.Screen
        options={{
          headerShown: true,
          title: section ? sections[section] : "Tools",
          headerLeft: () => (
            <Action
              label={section ? "Tools" : "Close"}
              onPress={() => (section ? setSection(null) : router.back())}
            />
          ),
        }}
      />
      {section === null &&
        (Object.keys(sections) as Section[]).map((key) => (
          <Action key={key} label={sections[key]} onPress={() => setSection(key)} />
        ))}
      {section === "backend" && <BackendManager />}
      {section === "accounts" && <Accounts />}
      {section === "recipes" && <Recipes />}
      {section === "enhance" && (
        <EnhanceImage sourceKey={params.sourceKey} sourceGenerationId={params.sourceGenerationId} />
      )}
    </ScrollView>
  );
}
