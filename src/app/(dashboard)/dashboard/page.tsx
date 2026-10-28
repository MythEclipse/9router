import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./endpoint/EndpointPageClient.tsx";

export default async function DashboardPage() {
  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} />;
}
