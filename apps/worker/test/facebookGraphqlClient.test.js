import test from "node:test";
import assert from "node:assert/strict";
import {
  buildListingDetailVariables,
  buildSearchVariables,
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
