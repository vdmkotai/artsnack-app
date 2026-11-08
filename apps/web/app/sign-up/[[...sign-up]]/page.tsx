import { redirect } from "next/navigation";

/**
 * There is no sign-up.
 *
 * This is a private, single-operator instance: access is an allowlist of Clerk
 * user ids checked in `proxy.ts` and in every public Convex function, so an
 * account created here could not do anything anyway. Rendering Clerk's
 * `<SignUp />` only advertised an entrance that leads nowhere.
 *
 * The route is kept rather than deleted: `NEXT_PUBLIC_CLERK_SIGN_UP_URL` points
 * at it and Clerk's own sign-in card links to it, so a 404 here would read as a
 * broken app.
 */
export default function SignUpPage() {
  redirect("/sign-in");
}
