import { useAction, useMutation, useQuery } from "convex/react";
import * as Clipboard from "expo-clipboard";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { api } from "@/convex/_generated/api";
import { Action, Note, confirm, useTask } from "./controls";

export function Accounts() {
  const connection = useQuery(api.grokAuth.getConnection);
  const start = useAction(api.grokAuthActions.startDeviceAuth);
  const poll = useAction(api.grokAuthActions.pollDeviceAuth);
  const disconnect = useMutation(api.grokAuth.disconnect);
  const account = useQuery(api.higgsfield.getAccount);
  const refreshBalance = useAction(api.higgsfieldProcessor.refreshBalance);
  const [auth, setAuth] = useState<Awaited<ReturnType<typeof start>> | null>(null);
  const [message, setMessage] = useState("");
  const task = useTask();
  useEffect(() => {
    if (!auth) return;
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const result = await poll({});
        if (canceled) return;
        if (result.status === "done") {
          setAuth(null);
          setMessage("Grok connected");
        } else if (result.status === "denied" || result.status === "expired") {
          setAuth(null);
          setMessage(`Grok sign-in ${result.status}. Try again.`);
        } else timer = setTimeout(tick, Math.max(1, auth.interval) * 1000);
      } catch (error) {
        if (!canceled) {
          setAuth(null);
          setMessage(error instanceof Error ? error.message : "Sign-in failed");
        }
      }
    };
    timer = setTimeout(tick, Math.max(1, auth.interval) * 1000);
    return () => {
      canceled = true;
      clearTimeout(timer);
    };
  }, [auth, poll]);
  return (
    <View style={{ gap: 12 }}>
      <Note>
        Grok:{" "}
        {connection === undefined
          ? "Loading…"
          : connection.connected
            ? (connection.email ?? "Connected")
            : "Not connected"}
      </Note>
      {connection?.connected ? (
        <Action
          label="Disconnect Grok"
          destructive
          disabled={task.busy}
          onPress={() =>
            confirm(
              "Disconnect Grok",
              "This also disconnects Grok in the web app.",
              () => void task.run(() => disconnect({})),
              true,
            )
          }
        />
      ) : (
        <Action
          label="Connect Grok"
          disabled={task.busy || !!auth}
          onPress={() =>
            void task.run(async () => {
              const info = await start({});
              setAuth(info);
              setMessage("");
              await Clipboard.setStringAsync(info.userCode);
              await WebBrowser.openBrowserAsync(
                info.verificationUriComplete ?? info.verificationUri,
              );
            })
          }
        />
      )}
      {auth && (
        <>
          <Note>Code: {auth.userCode}. Copied to clipboard. Waiting for authorization…</Note>
          <Action
            label="Open xAI sign-in"
            onPress={() =>
              void task.run(() =>
                WebBrowser.openBrowserAsync(auth.verificationUriComplete ?? auth.verificationUri),
              )
            }
          />
          <Action label="Cancel sign-in" onPress={() => setAuth(null)} />
        </>
      )}
      {message !== "" && <Note>{message}</Note>}
      <Note>
        Higgsfield:{" "}
        {account
          ? `${account.credits} credits${account.planType ? ` · ${account.planType}` : ""}`
          : "Balance unavailable"}
      </Note>
      <Action
        label="Refresh Higgsfield balance"
        disabled={task.busy}
        onPress={() => void task.run(() => refreshBalance({}))}
      />
    </View>
  );
}
