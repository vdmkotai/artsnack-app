import Link from "next/link";
import { FileQuestion } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="container flex min-h-[calc(100dvh-4rem)] flex-col items-center justify-center gap-6 px-4 py-12 text-center">
      <div className="rounded-full bg-muted/30 p-6">
        <FileQuestion className="h-12 w-12 text-muted-foreground/50" />
      </div>

      <div className="max-w-md space-y-2">
        <h2 className="text-2xl font-bold tracking-tight">Page not found</h2>
        <p className="text-muted-foreground">
          There is nothing at this address. The tabs above cover everything the app does.
        </p>
      </div>

      <Link href="/generate">
        <Button size="lg">Back to Generate</Button>
      </Link>
    </div>
  );
}
