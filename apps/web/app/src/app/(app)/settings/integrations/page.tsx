import { redirect } from "next/navigation";

// OpenAPI is the only integration in the Breeze internal tool.
export default function IntegrationsIndex(): never {
  redirect("/settings/integrations/openapi");
}
