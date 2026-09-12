import type { User } from "./types.ts";

export interface DemoAccount {
  user: User;
  password: string;
}

/**
 * Demo credentials. These are intentionally visible in client code because this
 * build has no backend — there is nothing to protect. Delete this file when the
 * real authentication service is connected.
 */
export const DEMO_PASSWORD = "demo123";

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { user: { id: "user1", email: "user1@demo.com", displayName: "User 1" }, password: DEMO_PASSWORD },
  { user: { id: "user2", email: "user2@demo.com", displayName: "User 2" }, password: DEMO_PASSWORD },
  { user: { id: "user3", email: "user3@demo.com", displayName: "User 3" }, password: DEMO_PASSWORD },
];

export const GUEST_USER: User = {
  id: "guest",
  email: "guest@demo.com",
  displayName: "Guest",
  isGuest: true,
};
