import { Suspense } from "react";
import { DesktopSignIn } from "@/components/desktop-sign-in";

export default function SignInPage() {
  return (
    <div className="flex min-h-screen items-center justify-center">
      <Suspense>
        <DesktopSignIn />
      </Suspense>
    </div>
  );
}
