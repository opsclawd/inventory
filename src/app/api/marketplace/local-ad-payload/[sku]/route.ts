import {
  handleLocalAdPayloadGet,
  handleLocalAdPayloadPatch,
} from '@/modules/marketplace/syndication/syndication-route.handler';

export const runtime = 'nodejs';

export async function GET(
  request: Request,
  context: { params: Promise<{ sku: string }> },
): Promise<Response> {
  const { sku } = await context.params;
  return handleLocalAdPayloadGet(request, sku);
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ sku: string }> },
): Promise<Response> {
  const { sku } = await context.params;
  return handleLocalAdPayloadPatch(request, sku);
}
