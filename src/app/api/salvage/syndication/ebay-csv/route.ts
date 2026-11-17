import {
  handleEbayCsvGet,
  handleEbayCsvPatch,
  handleEbayCsvPost,
} from '@/modules/marketplace/syndication/syndication-route.handler';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return handleEbayCsvGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleEbayCsvPost(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleEbayCsvPatch(request);
}
