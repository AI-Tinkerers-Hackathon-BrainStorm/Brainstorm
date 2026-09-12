import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";

export const metadata: Metadata = {
  title: "Login · SightLoop",
  description: "Sign in to SightLoop to keep your own agent memory.",
};

export default function LoginPage() {
  return <LoginForm />;
}
