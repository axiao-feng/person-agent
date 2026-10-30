import assert from "node:assert/strict";
import test from "node:test";

import { extractMimeBody } from "../src/integrations/mime.js";
import { geocodeCity, getWeather, type FetchLike } from "../src/integrations/weather.js";

test("extracts plain Gmail body and attachment metadata", () => {
  const result = extractMimeBody({
    mimeType: "multipart/mixed",
    parts: [
      { mimeType: "text/plain", body: { data: Buffer.from("第一行\n第二行").toString("base64url") } },
      {
        mimeType: "application/pdf",
        filename: "slides.pdf",
        body: { size: 1234, attachmentId: "attachment-1" },
      },
    ],
  });
  assert.equal(result.text, "第一行\n第二行");
  assert.deepEqual(result.attachments, [
    { filename: "slides.pdf", mimeType: "application/pdf", size: 1234, attachmentId: "attachment-1" },
  ]);
});

test("falls back to readable HTML text and truncates", () => {
  const result = extractMimeBody(
    { mimeType: "text/html", body: { data: Buffer.from("<p>Hello &amp; goodbye</p>").toString("base64url") } },
    8,
  );
  assert.equal(result.text, "Hello & ");
  assert.equal(result.truncated, true);
});

test("maps Open-Meteo geocoding and forecast responses", async () => {
  const responses = [
    new Response(
      JSON.stringify({
        results: [{ name: "上海", country: "中国", latitude: 31.23, longitude: 121.47, timezone: "Asia/Shanghai" }],
      }),
    ),
    new Response(
      JSON.stringify({
        current: {
          time: "2026-09-20T08:00",
          temperature_2m: 22,
          apparent_temperature: 23,
          precipitation_probability: 80,
          weather_code: 61,
          wind_speed_10m: 10,
        },
        hourly: {
          time: ["2026-09-20T09:00"],
          temperature_2m: [23],
          apparent_temperature: [24],
          precipitation_probability: [90],
          weather_code: [61],
          wind_speed_10m: [12],
        },
      }),
    ),
  ];
  const mockFetch: FetchLike = async () => responses.shift()!;
  const [location] = await geocodeCity("上海", mockFetch);
  assert.ok(location);
  const weather = await getWeather(location, undefined, mockFetch);
  assert.equal(weather.current.condition, "雨");
  assert.equal(weather.hourly[0]?.precipitationProbability, 90);
});
