import type { Metadata } from "next";
import { SITE_URL } from "@/constants/site-constants";
import { redirect } from "next/navigation";

export const metadata: Metadata = {
	alternates: {
		canonical: SITE_URL,
	},
};

export default async function Home() {
	redirect("/projects");
}
