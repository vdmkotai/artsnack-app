import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { useMutation } from "convex/react";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { BottomSheet } from "heroui-native";
import { Alert, Pressable, ScrollView, Text } from "react-native";

import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { colors, CONTINUOUS, TABULAR } from "@/theme/colors";

/** What `favoriteFolders.list` answers with — queried once, in the screen. */
export type FolderList = {
  folders: { _id: string; name: string; createdAt: number; count: number }[];
  unfiled: number;
  total: number;
};

/** One voice for every folder mutation's failure, in both components below. */
const failed = (error: unknown) =>
  Alert.alert("Folders", error instanceof Error ? error.message : "Unknown error");

/**
 * The folder rail: scope chips in the glass strip the Library's filters set the
 * shape of. All and each folder carry their counts; Unfiled appears only once a
 * folder exists, because before that it is the same set as All.
 *
 * Management is on the chips themselves — long-press for rename and delete, a
 * `+` chip to create — rather than on a separate screen, because a folder here
 * is a name and nothing else. Deleting one un-files its favourites; the confirm
 * says so, since "delete folder" reads like "delete contents" everywhere else.
 */
export function FolderBar({
  list,
  selected,
  onSelect,
}: {
  list: FolderList | undefined;
  selected: string | undefined;
  onSelect: (folder: string | undefined) => void;
}) {
  const create = useMutation(api.favoriteFolders.create);
  const rename = useMutation(api.favoriteFolders.rename);
  const remove = useMutation(api.favoriteFolders.remove);

  const promptCreate = () => {
    Alert.prompt("New folder", "Favourites can be filed into it right after.", (name) => {
      const trimmed = name?.trim();
      if (!trimmed) return;
      void create({ name: trimmed })
        // Creating selects, like the web: the next thing after making a folder
        // is almost always looking at it or filling it.
        .then(({ folderId }) => onSelect(folderId))
        .catch(failed);
    });
  };

  const manage = (folder: { _id: string; name: string; count: number }) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    Alert.alert(folder.name, undefined, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Rename",
        onPress: () =>
          Alert.prompt(
            "Rename folder",
            undefined,
            (name) => {
              const trimmed = name?.trim();
              if (!trimmed || trimmed === folder.name) return;
              void rename({ folderId: folder._id as Id<"favoriteFolders">, name: trimmed }).catch(
                failed,
              );
            },
            "plain-text",
            folder.name,
          ),
      },
      {
        text: "Delete",
        style: "destructive",
        onPress: () =>
          Alert.alert(
            `Delete “${folder.name}”?`,
            folder.count === 0
              ? "The folder is empty."
              : `Its ${folder.count} favourite${folder.count === 1 ? "" : "s"} go back to the main list, not away.`,
            [
              { text: "Cancel", style: "cancel" },
              {
                text: "Delete",
                style: "destructive",
                onPress: () => {
                  void remove({ folderId: folder._id as Id<"favoriteFolders"> })
                    .then(() => {
                      if (selected === folder._id) onSelect(undefined);
                    })
                    .catch(failed);
                },
              },
            ],
          ),
      },
    ]);
  };

  const folders = list?.folders ?? [];

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 5, paddingHorizontal: 4, alignItems: "center" }}
    >
      <FolderChip
        label="All"
        count={list?.total}
        active={selected === undefined}
        onPress={() => onSelect(undefined)}
      />
      {folders.length > 0 ? (
        <FolderChip
          label="Unfiled"
          count={list?.unfiled}
          active={selected === "none"}
          onPress={() => onSelect("none")}
        />
      ) : null}
      {folders.map((folder) => (
        <FolderChip
          key={folder._id}
          label={folder.name}
          count={folder.count}
          active={selected === folder._id}
          onPress={() => onSelect(folder._id)}
          onLongPress={() => manage(folder)}
        />
      ))}
      <Pressable
        onPress={promptCreate}
        accessibilityLabel="New folder"
        style={({ pressed }) => ({
          height: 30,
          paddingHorizontal: 10,
          borderRadius: 15,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.65 : 1,
        })}
      >
        <SymbolView
          name="plus"
          size={13}
          weight="semibold"
          tintColor={colors.labelSecondary}
          style={{ width: 15, height: 15 }}
        />
      </Pressable>
    </ScrollView>
  );
}

function FolderChip({
  label,
  count,
  active,
  onPress,
  onLongPress,
}: {
  label: string;
  count?: number;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        height: 30,
        paddingHorizontal: 13,
        borderRadius: 15,
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        // Inactive chips are transparent inside the glass strip — see the Library.
        backgroundColor: active ? colors.accent : "transparent",
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Text
        numberOfLines={1}
        style={{
          fontSize: 14,
          fontWeight: active ? "600" : "500",
          color: active ? colors.onAccent : colors.labelSecondary,
          maxWidth: 150,
        }}
      >
        {label}
      </Text>
      {count !== undefined ? (
        <Text
          style={{
            fontSize: 11.5,
            color: active ? colors.onAccent : colors.labelTertiary,
            opacity: active ? 0.6 : 1,
            ...TABULAR,
          }}
        >
          {count}
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Where the selection goes: a sheet of destinations, because the web's popover
 * has no equivalent over a glass toolbar. "Unfiled" is first — it is the only
 * destination that removes rather than adds — and "New folder…" is last,
 * creating and moving in one step the way the web's inline form does.
 */
export function MoveSheet({
  open,
  onOpenChange,
  list,
  onMove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  list: FolderList | undefined;
  onMove: (folderId: string | undefined, folderName: string) => void;
}) {
  const create = useMutation(api.favoriteFolders.create);

  const pick = (folderId: string | undefined, folderName: string) => {
    onOpenChange(false);
    onMove(folderId, folderName);
  };

  const promptCreateAndMove = () => {
    Alert.prompt("New folder", "The selection moves into it.", (name) => {
      const trimmed = name?.trim();
      if (!trimmed) return;
      void create({ name: trimmed })
        .then(({ folderId }) => pick(folderId, trimmed))
        .catch(failed);
    });
  };

  return (
    <BottomSheet isOpen={open} onOpenChange={onOpenChange}>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        <BottomSheet.Content
          snapPoints={["45%", "85%"]}
          enableOverDrag={false}
          enableDynamicSizing={false}
          contentContainerClassName="h-full px-0"
          backgroundClassName="bg-surface"
          handleIndicatorClassName="bg-muted"
        >
          <BottomSheetScrollView
            contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 44, gap: 8 }}
          >
            <Text
              style={{
                color: colors.labelTertiary,
                fontSize: 11.5,
                fontWeight: "600",
                letterSpacing: 0.7,
                paddingHorizontal: 4,
                paddingBottom: 4,
              }}
            >
              MOVE TO
            </Text>
            <Destination
              label="Unfiled"
              detail="Out of its folder, back into the main list."
              onPress={() => pick(undefined, "Unfiled")}
            />
            {(list?.folders ?? []).map((folder) => (
              <Destination
                key={folder._id}
                label={folder.name}
                detail={`${folder.count} favourite${folder.count === 1 ? "" : "s"}`}
                onPress={() => pick(folder._id, folder.name)}
              />
            ))}
            <Destination label="New folder…" onPress={promptCreateAndMove} />
          </BottomSheetScrollView>
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}

function Destination({
  label,
  detail,
  onPress,
}: {
  label: string;
  detail?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        backgroundColor: pressed ? colors.surfaceRaised : colors.surface,
        borderRadius: 14,
        minHeight: 50,
        paddingHorizontal: 16,
        paddingVertical: 11,
        justifyContent: "center",
        ...CONTINUOUS,
      })}
    >
      <Text style={{ color: colors.label, fontSize: 16 }}>{label}</Text>
      {detail ? (
        <Text style={{ color: colors.labelTertiary, fontSize: 12.5, marginTop: 1 }}>{detail}</Text>
      ) : null}
    </Pressable>
  );
}
