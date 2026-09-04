export default {
  async fetch(request, env) {
    return new Response("Versys is running.", { status: 200 });
  },
};
