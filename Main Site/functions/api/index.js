export async function onRequest() {
  return new Response(JSON.stringify({ status: "API live" }), {
    headers: { "Content-Type": "application/json" }
  });
}