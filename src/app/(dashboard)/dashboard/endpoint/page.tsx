import { getMachineId } from "@/shared/utils/machine";
import EndpointPageClient from "./EndpointPageClient.tsx";

export default async function EndpointPage() {
  const machineId = await getMachineId();
  return <EndpointPageClient machineId={machineId} />;
}
