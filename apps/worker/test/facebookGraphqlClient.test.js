import test from "node:test";
import assert from "node:assert/strict";
import {
  buildListingDetailVariables,
  buildSearchVariables,
  FacebookGraphqlClient,
  parseMarketplaceSearchHtml,
  parseListingDetailResponse,
  parseListingImagesResponse,
  parseSearchResponse
} from "../src/facebookGraphqlClient.js";
import { shouldFetchDetail } from "../src/syncEngine.js";

test("Marketplace searches request newest listings first", () => {
  const variables = buildSearchVariables({
    query: "Scion FR-S",
    latitude: 37.4,
    longitude: -121.9,
    radiusKm: 40,
    limit: 25
  });

  assert.equal(variables.params.browse_request_params.sort_by, "creation_time_descend");
  assert.equal(variables.params.browse_request_params.commerce_search_and_rp_ctime_days, 1);
});

test("GraphQL requests include Facebook's Comet request context", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false });
  client.ensureSession = async () => ({ cookieHeader: "", fbDtsg: "token", lsd: "", jazoest: "", clientRevision: "1" });
  let requestBody;
  client.request = async (_url, options) => {
    requestBody = new URLSearchParams(options.body);
    return new Response(JSON.stringify({ data: { ok: true } }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  await client.graphqlRequest("test-doc", {});

  assert.equal(requestBody.get("__a"), "1");
  assert.equal(requestBody.get("__comet_req"), "15");
});

test("rich GraphQL cards are kept when the pagination cursor also contains placeholder IDs", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false });
  client.graphqlRequest = async () => ({
    data: { marketplace_search: { feed_units: {
      edges: [{ node: { listing: {
        id: "listing-123",
        marketplace_listing_title: "2019 Chevrolet Corvette",
        listing_price: { formatted_amount: "$35,000" },
        location: { reverse_geocode: { city: "Oakland", state: "California" } },
        primary_listing_photo: { image: { uri: "https://images.example/corvette.jpg" } }
      } } }],
      page_info: { end_cursor: JSON.stringify({ c2c: { sspi: ["cursor-only-id"] } }), has_next_page: true }
    } } }
  });
  client.request = async () => { throw new Error("page fallback should not run"); };

  const result = await client.searchListings({ query: "corvette", latitude: 37, longitude: -122, radiusKm: 40, limit: 5 });

  assert.equal(result.listings[0].id, "listing-123");
  assert.equal(result.listings[0].title, "2019 Chevrolet Corvette");
  assert.equal(result.listings[0].price, "$35,000");
  assert.equal(result.listings[0].imageUrl, "https://images.example/corvette.jpg");
  assert.equal(result.listings.length, 1, "cursor IDs do not become fake listing cards when a real edge card exists");
  assert.equal(result.diagnostics.cursorPlaceholderCount, 1);
  assert.equal(result.diagnostics.richListingCount, 1);
});

test("search freshness window is configurable and photo GraphQL results are listing-scoped", () => {
  const variables = buildSearchVariables({ query: "camera", latitude: 1, longitude: 2, radiusKm: 10, limit: 10, newestWithinDays: 1 });
  assert.equal(variables.params.browse_request_params.commerce_search_and_rp_ctime_days, 1);

  const images = parseListingImagesResponse({
    data: {
      viewer: {
        marketplace_product_details_page: {
          target: {
            listing_photos: [
              { image: { uri: "https://images.example/one.jpg" } },
              { image: { uri: "https://images.example/two.jpg" } },
              { image: { uri: "https://images.example/one.jpg" } }
            ]
          }
        }
      }
    }
  });
  assert.deepEqual(images, ["https://images.example/one.jpg", "https://images.example/two.jpg"]);
});

test("search parser extracts listing fields and posted time from feed nodes", () => {
  const result = parseSearchResponse({
    data: {
      marketplace_search: {
        feed_units: {
          edges: [{
            node: {
              listing: {
                id: "12345",
                marketplace_listing_title: "2015 Scion FR-S",
                listing_price: { formatted_amount: "$1,234" },
                creation_time: 1_757_000_000,
                primary_listing_photo: { image: { uri: "https://images.example/car.jpg" } }
              }
            }
          }],
          page_info: { has_next_page: false }
        }
      }
    }
  });

  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].title, "2015 Scion FR-S");
  assert.equal(result.listings[0].price, "$1,234");
  assert.equal(result.listings[0].imageUrl, "https://images.example/car.jpg");
  assert.equal(result.listings[0].postedDate, new Date(1_757_000_000 * 1000).toISOString());
});

test("cursor-only Marketplace responses report the missing card fields without exposing listing data", () => {
  const endCursor = JSON.stringify({ c2c: { sspi: ["listing-123"] } });
  const result = parseSearchResponse({
    data: { marketplace_search: { feed_units: {
      edges: [{ node: { feed_unit: { id: "wrapper-1" } } }],
      page_info: { end_cursor: endCursor, has_next_page: false }
    } } }
  });

  assert.equal(result.listings.length, 1);
  assert.equal(result.listings[0].title, "Marketplace listing");
  assert.equal(result.diagnostics.edgeCount, 1);
  assert.equal(result.diagnostics.richListingCount, 0);
  assert.equal(result.diagnostics.cursorPlaceholderCount, 1);
  assert.deepEqual(result.diagnostics.firstNodeKeys, ["feed_unit"]);
  assert.ok(result.diagnostics.firstNodeFieldPaths.includes("node.feed_unit.id:string"));
  assert.equal(JSON.stringify(result.diagnostics).includes("listing-123"), false);
});

test("Marketplace search page parser recovers titles, prices, locations, and thumbnails", () => {
  const html = `<div><a href="/marketplace/item/123456/?ref=search"><img src="https://images.example/car.jpg?x=1&amp;y=2"><span>2007 Chevrolet Corvette Coupe 2D</span><span>$18,000</span><span>Lafayette, CA</span></a></div>`;
  const [listing] = parseMarketplaceSearchHtml(html, 10);
  assert.equal(listing.id, "123456");
  assert.equal(listing.title, "2007 Chevrolet Corvette Coupe 2D");
  assert.equal(listing.price, "$18,000");
  assert.equal(listing.location, "Lafayette, CA");
  assert.equal(listing.imageUrl, "https://images.example/car.jpg?x=1&y=2");
});

test("placeholder GraphQL cards fall back to the signed-in Marketplace search page", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false, facebookCookie: "c_user=1; xs=active" });
  client.ensureSession = async () => ({ cookieHeader: "c_user=1; xs=active" });
  client.graphqlRequest = async () => ({
    data: { marketplace_search: { feed_units: {
      edges: [{ node: { story_type: "listing" } }],
      page_info: { end_cursor: JSON.stringify({ c2c: { sspi: ["123456"] } }), has_next_page: true }
    } } }
  });
  let requestedUrl;
  client.request = async (url) => {
    requestedUrl = new URL(url);
    return new Response(`<a href="/marketplace/item/123456/"><img src="https://images.example/car.jpg">2020 Corvette $25,000 San Jose, CA</a>`, {
      status: 200,
      headers: { "content-type": "text/html" }
    });
  };
  const result = await client.searchListings({
    query: "corvette", latitude: 37, longitude: -122, radiusKm: 40, limit: 5, location: "San Jose, CA"
  });
  assert.equal(requestedUrl.searchParams.get("query"), "corvette");
  assert.equal(requestedUrl.searchParams.get("location"), "San Jose, CA");
  assert.equal(requestedUrl.searchParams.get("latitude"), "37");
  assert.equal(requestedUrl.searchParams.get("longitude"), "-122");
  assert.equal(result.listings[0].title, "2020 Corvette");
  assert.equal(result.listings[0].imageUrl, "https://images.example/car.jpg");
  assert.equal(result.diagnostics.cardSource, "marketplace_search_page");
});

test("search page fallback never sends Facebook cookies to a profile-supplied non-Facebook URL", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false, facebookCookie: "c_user=1; xs=active" });
  client.ensureSession = async () => ({ cookieHeader: "c_user=1; xs=active" });
  client.graphqlRequest = async () => ({
    data: { marketplace_search: { feed_units: {
      edges: [], page_info: { end_cursor: JSON.stringify({ sspi: ["123456"] }), has_next_page: false }
    } } }
  });
  let requested = false;
  client.request = async () => { requested = true; throw new Error("should not make a request"); };
  await assert.rejects(
    client.searchListings({ query: "corvette", latitude: 37, longitude: -122, radiusKm: 40, limit: 5, searchUrl: "https://example.com/marketplace/search" }),
    /must point to a Facebook Marketplace page/
  );
  assert.equal(requested, false);
});

test("authenticated cookie mode rejects a local browser profile without an active Facebook login", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false, facebookCookie: "datr=public-only" });
  await assert.rejects(client.ensureSession(), /FB_COOKIE must include an active Facebook session/);
});

test("an empty Marketplace feed that advertises another page fails instead of reporting a successful zero-result run", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false });
  client.graphqlRequest = async () => ({
    data: { marketplace_search: { feed_units: { edges: [], page_info: { has_next_page: true } } } }
  });
  await assert.rejects(
    client.searchListings({ query: "corvette", latitude: 37, longitude: -122, radiusKm: 50, limit: 3 }),
    error => {
      assert.match(error.message, /empty Marketplace feed while reporting more pages/);
      assert.equal(error.searchInspection.state, 'failed');
      assert.equal(error.searchInspection.requestVariables.params.browse_request_params.commerce_search_and_rp_ctime_days, 1);
      assert.deepEqual(error.searchInspection.response.data.marketplace_search.feed_units.edges, []);
      assert.equal(error.searchInspection.diagnostics.edgeCount, 0);
      assert.equal(error.searchInspection.hasNextPage, true);
      assert.deepEqual(error.searchInspection.fallback, {attempted: false, reason: 'empty_feed_without_cursor_placeholders'});
      return true;
    }
  );
});

test("listing detail uses the Marketplace GraphQL operation and normalizes its result", () => {
  const variables = buildListingDetailVariables("12345");
  assert.equal(variables.targetId, "12345");
  assert.equal(variables.feedLocation, "MARKETPLACE_MEGAMALL");

  const listing = parseListingDetailResponse({
    data: {
      viewer: {
        marketplace_product_details_page: {
          target: {
            id: "12345",
            marketplace_listing_title: "2015 Scion FR-S",
            redacted_description: { text: "Clean title; 81k miles" },
            listing_price: { formatted_amount: "$1,234" },
            primary_listing_photo: { image: { uri: "https://images.example/car.jpg" } },
            listing_photos: [{ image: { uri: "https://images.example/car.jpg" } }, { image: { uri: "https://images.example/side.jpg" } }],
            creation_time: 1_757_000_000,
            location_text: { text: "Lodi, California" },
            is_pending: false,
            is_sold: false,
            attribute_data: [
              { attribute_name: "Mileage", label: "81,000 miles" },
              { attribute_name: "Transmission", label: "6-Speed Manual" },
              { attribute_name: "Exterior Color", label: "World Rally Blue" }
            ]
          }
        }
      }
    }
  }, "12345");

  assert.equal(listing.title, "2015 Scion FR-S");
  assert.equal(listing.description, "Clean title; 81k miles");
  assert.equal(listing.price, "$1,234");
  assert.equal(listing.location, "Lodi, California");
  assert.deepEqual(listing.images, ["https://images.example/car.jpg", "https://images.example/side.jpg"]);
  assert.equal(listing.postedDate, new Date(1_757_000_000 * 1000).toISOString());
  assert.equal(listing.mileage, 81000);
  assert.equal(listing.vehicleAttributes.mileage, 81000);
  assert.equal(listing.vehicleAttributes.transmission, "manual");
  assert.equal(listing.vehicleAttributes.exterior_color, "World Rally Blue");
});

test("Marketplace vehicle mileage fields are normalized even outside attribute_data", () => {
  const listing = parseListingDetailResponse(
    { data: { viewer: { marketplace_product_details_page: { target: {
      id: "67890", vehicle_mileage: { formatted_value: "53,701 miles" }
    } } } } },
    "67890"
  );
  assert.equal(listing.mileage, 53701);
});

test("sync fetches details only for incomplete, inconsistent, or stale listings", () => {
  const recent = new Date().toISOString();
  const common = {
    status: "new",
    description_raw: "Vehicle description",
    image_urls: ["https://images.example/car.jpg"],
    price_raw: "$1,234",
    last_scraped_at: recent
  };

  assert.equal(shouldFetchDetail({ ...common, current_price: 7800 }, 24), true);
  assert.equal(shouldFetchDetail({ ...common, current_price: 1234, image_urls: ["car.jpg", "side.jpg"] }, 24), false);
  assert.equal(shouldFetchDetail({ ...common, current_price: 1234 }, 24), false);
  assert.equal(shouldFetchDetail({ ...common, current_price: 1234, description_raw: "  " }, 24), true);
  assert.equal(shouldFetchDetail({ ...common, current_price: 1234, image_urls: [] }, 24), true);
  assert.equal(shouldFetchDetail({ ...common, current_price: 1234, last_scraped_at: new Date(Date.now() - 25 * 3_600_000).toISOString() }, 24), true);
  assert.equal(shouldFetchDetail({ ...common, current_price: 1234, status: "saved", last_scraped_at: new Date(Date.now() - 13 * 3_600_000).toISOString() }, 24), true);
  assert.equal(shouldFetchDetail({ ...common, status: "hidden", image_urls: [] }, 24), false);
});

test("cookie-free session obtains page tokens without Chrome extraction", async () => {
  const { FacebookGraphqlClient } = await import('../src/facebookGraphqlClient.js');
  const client = new FacebookGraphqlClient({ useChromeCookies: false });
  client.extractTokens = async cookie => {
    assert.equal(cookie, '');
    return { fbDtsg: 'public-page-token', lsd: 'public-lsd' };
  };
  const session = await client.ensureSession();
  assert.equal(session.userId, '0');
  assert.equal(session.cookieHeader, '');
  assert.equal(session.fbDtsg, 'public-page-token');
});

test("explicit cookie session remains available", async () => {
  const { FacebookGraphqlClient } = await import('../src/facebookGraphqlClient.js');
  const client = new FacebookGraphqlClient({ facebookCookie: 'c_user=123; xs=test', useChromeCookies: false });
  client.extractTokens = async cookie => {
    assert.equal(cookie, 'c_user=123; xs=test');
    return { fbDtsg: 'token' };
  };
  assert.equal((await client.ensureSession()).userId, '123');
});


test("rejected search retains sanitized HTTP and GraphQL evidence", async () => {
  const client = new FacebookGraphqlClient({ useChromeCookies: false });
  const session = {cookieHeader: 'c_user=123456789; xs=private-cookie', fbDtsg: 'private-token', lsd: 'private-lsd'};
  client.ensureSession = async () => { client.session = session; return session; };
  client.request = async () => new Response(JSON.stringify({
    errors: [{code: 123, message: 'Denied private-cookie private-token https://facebook.com/login/?access_token=secret'}],
    data: {marketplace_search: null}, fb_dtsg: 'private-token', nested: {access_token: 'secret'}
  }), {status: 200, headers: {'content-type': 'text/html'}});
  await assert.rejects(client.searchListings({query: 'corvette', limit: 3}), /Facebook rejected/);
  const report = client.lastSearchInspection;
  assert.equal(report.state, 'failed');
  assert.equal(report.transport.httpStatus, 200);
  assert.equal(report.response.errors[0].code, 123);
  assert.equal(report.response.data.marketplace_search, null);
  const serialized = JSON.stringify(report);
  for (const secret of ['private-cookie', 'private-token', 'private-lsd', 'access_token', 'fb_dtsg', '123456789']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});


test("diagnostic records the exact widened freshness request", async () => {
  const client = new FacebookGraphqlClient({useChromeCookies:false});
  let sent;
  client.graphqlRequest = async (_doc, variables) => {sent = variables; return {data:{marketplace_search:{feed_units:{edges:[],page_info:{has_next_page:false}}}}};};
  await client.searchListings({query:'corvette',latitude:37.4,longitude:-121.9,radiusKm:161,limit:25,newestWithinDays:7});
  assert.deepEqual(client.lastSearchInspection.requestVariables, sent);
  assert.equal(sent.params.browse_request_params.commerce_search_and_rp_ctime_days, 7);
});
