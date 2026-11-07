// Help-center articles are authored in a third-party CMS that support staff and contractors can edit.
export async function searchArticles(query: string) {
  return [
    { title: "Returns and refunds policy", url: "https://help.acme.dev/refunds", body: "Items can be returned within 30 days of delivery." },
  ].filter((a) => a.title.toLowerCase().includes(query.toLowerCase()) || query.length > 0);
}
