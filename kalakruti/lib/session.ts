import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { isValidSession, SESSION_COOKIE } from "./auth";
import { getStore, type Store } from "./store";

/** For pages and server actions: the owner's data store, or redirect to login. */
export async function ownerStore(): Promise<Store> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!(await isValidSession(token))) redirect("/login");
  return getStore(token);
}
