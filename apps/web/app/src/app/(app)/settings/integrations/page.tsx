import { redirect } from "next/navigation";

// OpenAPI is the default integration page; GitHub sync sits beside it.
export default function IntegrationsIndex(): never {
  redirect("/settings/integrations/openapi");
}
