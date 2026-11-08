"use client";

import * as React from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

type DeviceAuthInfo = {
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
};

/**
 * Device-authorization login for the user's Grok (SuperGrok) subscription:
 * shows a code + link, then polls auth.x.ai (via a Convex action) until the
 * user approves. Mirrors `grok login --device-auth` from the grok CLI.
 */
export function GrokConnect({ onConnected }: { onConnected: () => void }) {
  const startDeviceAuth = useAction(api.grokAuthActions.startDeviceAuth);
  const pollDeviceAuth = useAction(api.grokAuthActions.pollDeviceAuth);

  const [deviceAuth, setDeviceAuth] = React.useState<DeviceAuthInfo | null>(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const [isWaiting, setIsWaiting] = React.useState(false);

  const start = React.useCallback(async () => {
    setIsStarting(true);
    // Rejection is handled on the promise rather than with try/catch/finally:
    // the React Compiler cannot lower a `try` holding a finalizer or a
    // conditional, and abandons the whole enclosing component when it meets one.
    const info = await startDeviceAuth({}).catch((e: unknown) => {
      toast.error(e instanceof Error ? e.message : "Failed to start Grok sign-in");
      return null;
    });
    if (info) {
      setDeviceAuth(info);
      setIsWaiting(true);
      // noopener so auth.x.ai never gets a handle back on this window.
      window.open(
        info.verificationUriComplete ?? info.verificationUri,
        "_blank",
        "noopener,noreferrer",
      );
    }
    setIsStarting(false);
  }, [startDeviceAuth]);

  React.useEffect(() => {
    if (!deviceAuth || !isWaiting) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      if (cancelled) return;
      // Same reason as `start` above: no try/catch, so the compiler keeps this
      // component. A rejection resolves to null after reporting itself.
      const result = await pollDeviceAuth({}).catch((e: unknown) => {
        if (!cancelled) {
          setIsWaiting(false);
          setDeviceAuth(null);
          toast.error(e instanceof Error ? e.message : "Grok sign-in failed");
        }
        return null;
      });
      if (cancelled || !result) return;
      if (result.status === "done") {
        setIsWaiting(false);
        setDeviceAuth(null);
        toast.success(result.email ? `Connected to Grok as ${result.email}` : "Connected to Grok");
        onConnected();
        return;
      }
      if (result.status === "denied") {
        setIsWaiting(false);
        setDeviceAuth(null);
        toast.error("Grok sign-in was denied");
        return;
      }
      if (result.status === "expired") {
        setIsWaiting(false);
        setDeviceAuth(null);
        toast.error("Grok sign-in code expired — try again");
        return;
      }
      timer = setTimeout(tick, deviceAuth.interval * 1000);
    };

    timer = setTimeout(tick, deviceAuth.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [deviceAuth, isWaiting, pollDeviceAuth, onConnected]);

  if (!deviceAuth) {
    return (
      <div className="border rounded-lg p-6 space-y-4">
        <div className="space-y-1">
          <h3 className="font-semibold">Connect your Grok account</h3>
          <p className="text-sm text-muted-foreground">
            Sign in with your xAI account to generate images and videos with Grok Imagine using your
            SuperGrok subscription.
          </p>
        </div>
        <Button onClick={start} disabled={isStarting}>
          {isStarting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Starting...
            </>
          ) : (
            "Connect Grok account"
          )}
        </Button>
      </div>
    );
  }

  return (
    <div className="border rounded-lg p-6 space-y-4">
      <div className="space-y-1">
        <h3 className="font-semibold">Finish signing in</h3>
        <p className="text-sm text-muted-foreground">
          Open the link below and confirm this code with your xAI account:
        </p>
      </div>
      <div className="text-2xl font-mono font-bold tracking-widest text-center py-2 bg-muted rounded">
        {deviceAuth.userCode}
      </div>
      <div className="flex items-center gap-2">
        <a
          href={deviceAuth.verificationUriComplete ?? deviceAuth.verificationUri}
          target="_blank"
          rel="noopener noreferrer"
          className="flex-1 inline-flex items-center justify-center gap-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 h-9 px-4 text-sm font-medium transition-colors"
        >
          <ExternalLink className="h-4 w-4" />
          Open xAI sign-in
        </a>
        <Button
          variant="outline"
          onClick={() => {
            setIsWaiting(false);
            setDeviceAuth(null);
          }}
        >
          Cancel
        </Button>
      </div>
      <p className="text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Waiting for authorization...
      </p>
    </div>
  );
}
