import {
  handleDomesticCheckoutGet,
  handleDomesticCheckoutPatch,
  handleDomesticCheckoutPost,
} from '@/modules/logistics-vault/checkout/domestic-checkout-route.handler';

export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  return handleDomesticCheckoutGet(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleDomesticCheckoutPost(request);
}

export async function PATCH(request: Request): Promise<Response> {
  return handleDomesticCheckoutPatch(request);
}
