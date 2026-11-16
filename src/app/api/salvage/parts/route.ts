import {
  handleSalvagePartsGet,
  handleSalvagePartsPatch,
  handleSalvagePartsPost,
} from '@/modules/dismantling/part-strip/parts-route.handler';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return handleSalvagePartsGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleSalvagePartsPost(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleSalvagePartsPatch(request);
}
