import type { AppConfig } from "../config.js";

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type WeatherLocation = NonNullable<AppConfig["location"]>;

export type WeatherPoint = {
  time: string;
  temperature: number | null;
  apparentTemperature: number | null;
  precipitationProbability: number | null;
  windSpeed: number | null;
  weatherCode: number | null;
  condition: string;
};

export type WeatherForecast = {
  location: WeatherLocation;
  current: WeatherPoint;
  hourly: WeatherPoint[];
};

export async function geocodeCity(city: string, fetcher: FetchLike = fetch): Promise<WeatherLocation[]> {
  const normalized = city.trim();
  if (!normalized) throw new Error("城市不能为空。");
  const params = new URLSearchParams({ name: normalized, count: "5", language: "zh", format: "json" });
  const response = await fetcher(`https://geocoding-api.open-meteo.com/v1/search?${params}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error("城市查询服务暂时不可用。");
  const data = (await response.json()) as {
    results?: Array<{
      name?: string;
      admin1?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
      timezone?: string;
    }>;
  };
  return (data.results ?? [])
    .filter(
      (item): item is Required<Pick<typeof item, "name" | "latitude" | "longitude" | "timezone">> & typeof item =>
        typeof item.name === "string" &&
        typeof item.latitude === "number" &&
        typeof item.longitude === "number" &&
        typeof item.timezone === "string",
    )
    .map((item) => ({
      city: [item.name, item.admin1, item.country].filter(Boolean).join(", "),
      latitude: item.latitude,
      longitude: item.longitude,
      timezone: item.timezone,
    }));
}

export async function getWeather(
  location: WeatherLocation,
  signal?: AbortSignal,
  fetcher: FetchLike = fetch,
): Promise<WeatherForecast> {
  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: location.timezone,
    forecast_hours: "12",
    current: "temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m",
    hourly: "temperature_2m,apparent_temperature,precipitation_probability,weather_code,wind_speed_10m",
  });
  const combinedSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  let response: Response;
  try {
    response = await fetcher(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: combinedSignal });
  } catch {
    throw new Error("天气服务暂时不可用。");
  }
  if (!response.ok) throw new Error("天气服务暂时不可用。");
  const data = (await response.json()) as WeatherResponse;
  const current = pointFromCurrent(data.current);
  const times = data.hourly?.time ?? [];
  const hourly = times.slice(0, 12).map((time, index) =>
    point({
      time,
      temperature: data.hourly?.temperature_2m?.[index],
      apparentTemperature: data.hourly?.apparent_temperature?.[index],
      precipitationProbability: data.hourly?.precipitation_probability?.[index],
      windSpeed: data.hourly?.wind_speed_10m?.[index],
      weatherCode: data.hourly?.weather_code?.[index],
    }),
  );
  return { location, current, hourly };
}

type WeatherResponse = {
  current?: {
    time?: string;
    temperature_2m?: number;
    apparent_temperature?: number;
    precipitation_probability?: number;
    weather_code?: number;
    wind_speed_10m?: number;
  };
  hourly?: {
    time?: string[];
    temperature_2m?: number[];
    apparent_temperature?: number[];
    precipitation_probability?: number[];
    weather_code?: number[];
    wind_speed_10m?: number[];
  };
};

function pointFromCurrent(value: WeatherResponse["current"]): WeatherPoint {
  if (!value?.time) throw new Error("天气服务返回的数据不完整。");
  return point({
    time: value.time,
    temperature: value.temperature_2m,
    apparentTemperature: value.apparent_temperature,
    precipitationProbability: value.precipitation_probability,
    windSpeed: value.wind_speed_10m,
    weatherCode: value.weather_code,
  });
}

function point(value: {
  time: string;
  temperature: number | undefined;
  apparentTemperature: number | undefined;
  precipitationProbability: number | undefined;
  windSpeed: number | undefined;
  weatherCode: number | undefined;
}): WeatherPoint {
  return {
    time: value.time,
    temperature: finiteOrNull(value.temperature),
    apparentTemperature: finiteOrNull(value.apparentTemperature),
    precipitationProbability: finiteOrNull(value.precipitationProbability),
    windSpeed: finiteOrNull(value.windSpeed),
    weatherCode: finiteOrNull(value.weatherCode),
    condition: weatherCondition(value.weatherCode),
  };
}

function finiteOrNull(value: number | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function weatherCondition(code: number | undefined): string {
  if (code === 0) return "晴";
  if (code === 1 || code === 2) return "多云";
  if (code === 3) return "阴";
  if (code === 45 || code === 48) return "雾";
  if (code !== undefined && code >= 51 && code <= 67) return "雨";
  if (code !== undefined && code >= 71 && code <= 77) return "雪";
  if (code !== undefined && code >= 80 && code <= 82) return "阵雨";
  if (code !== undefined && code >= 85 && code <= 86) return "阵雪";
  if (code !== undefined && code >= 95) return "雷暴";
  return "未知";
}
