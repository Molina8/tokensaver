// Config pública del proyecto (la publishable key es segura de exponer:
// solo permite operar como usuario anónimo/autenticado bajo RLS).
export const SUPABASE_URL = "https://tqahseolbmatwttrwmyx.supabase.co";
export const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_iI8G-jkc2R4aEuZ7cZHErA_UfYA_bm0";
// Pagos: Stripe Payment Links en modo real. Se les añade ?client_reference_id=<user id>
// al hacer clic para saber a quién acreditar los informes.
export const CHECKOUT_LINKS = {
  single: "https://buy.stripe.com/3cI8wOacVe7Vf8S9KI5Ne00",
  pack10: "https://buy.stripe.com/4gMcN45WF2pd5yi6yw5Ne01",
};
