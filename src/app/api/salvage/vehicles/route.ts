import {
  handleSalvageVehiclesGet,
  handleSalvageVehiclesPost,
} from '@/modules/dismantling/vehicle-intake/vehicles-route.handler';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return handleSalvageVehiclesGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSalvageVehiclesPost(request);
}
