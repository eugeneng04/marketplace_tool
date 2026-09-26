import { createId } from "./utils.js";

export const SUGGESTED_GENERATIONS = [
  { make: "BMW", model: "M3", code: "E36", yearFrom: 1995, yearTo: 1999 },
  { make: "BMW", model: "M3", code: "E46", yearFrom: 2001, yearTo: 2006 },
  { make: "BMW", model: "M3", code: "E90", yearFrom: 2008, yearTo: 2013 },
  { make: "BMW", model: "M3", code: "F80", yearFrom: 2015, yearTo: 2018 },
  { make: "BMW", model: "M3", code: "G80", yearFrom: 2021, yearTo: 2026 },
  { make: "Porsche", model: "911", code: "996", yearFrom: 1999, yearTo: 2004 },
  { make: "Porsche", model: "911", code: "997", yearFrom: 2005, yearTo: 2011 },
  { make: "Porsche", model: "911", code: "991", yearFrom: 2012, yearTo: 2019 },
  { make: "Porsche", model: "911", code: "992", yearFrom: 2020, yearTo: 2026 },
  { make: "BMW", model: "M3", code: "E30", yearFrom: 1987, yearTo: 1991 },
  { make: "BMW", model: "3 Series", code: "E30", yearFrom: 1984, yearTo: 1991 },
  { make: "BMW", model: "3 Series", code: "E36", yearFrom: 1992, yearTo: 1999 },
  { make: "BMW", model: "3 Series", code: "E46", yearFrom: 1999, yearTo: 2006 },
  { make: "BMW", model: "3 Series", code: "E90", yearFrom: 2006, yearTo: 2013 },
  { make: "BMW", model: "3 Series", code: "F30", yearFrom: 2012, yearTo: 2018 },
  { make: "BMW", model: "3 Series", code: "G20", yearFrom: 2019, yearTo: 2026 },
  { make: "Porsche", model: "911", code: "964", yearFrom: 1990, yearTo: 1994 },
  { make: "Porsche", model: "911", code: "993", yearFrom: 1995, yearTo: 1998 },
  { make: "Porsche", model: "Cayman", code: "987", yearFrom: 2006, yearTo: 2012 },
  { make: "Porsche", model: "Cayman", code: "981", yearFrom: 2014, yearTo: 2016 },
  { make: "Porsche", model: "Cayman", code: "982 / 718", yearFrom: 2017, yearTo: 2026 },
  { make: "Honda", model: "Civic", code: "1st gen", yearFrom: 1973, yearTo: 1979 },
  { make: "Honda", model: "Civic", code: "2nd gen", yearFrom: 1980, yearTo: 1983 },
  { make: "Honda", model: "Civic", code: "3rd gen", yearFrom: 1984, yearTo: 1987 },
  { make: "Honda", model: "Civic", code: "4th gen", yearFrom: 1988, yearTo: 1991 },
  { make: "Honda", model: "Civic", code: "5th gen", yearFrom: 1992, yearTo: 1995 },
  { make: "Honda", model: "Civic", code: "6th gen", yearFrom: 1996, yearTo: 2000 },
  { make: "Honda", model: "Civic", code: "7th gen", yearFrom: 2001, yearTo: 2005 },
  { make: "Honda", model: "Civic", code: "8th gen", yearFrom: 2006, yearTo: 2011 },
  { make: "Honda", model: "Civic", code: "9th gen", yearFrom: 2012, yearTo: 2015 },
  { make: "Honda", model: "Civic", code: "10th gen", yearFrom: 2016, yearTo: 2021 },
  { make: "Honda", model: "Civic", code: "11th gen", yearFrom: 2022, yearTo: 2026 }
];

export function validateGeneration(input) {
  const make = `${input.make ?? ""}`.trim();
  const model = `${input.model ?? ""}`.trim();
  const code = `${input.code ?? ""}`.trim();
  const yearFrom = Number(input.yearFrom);
  const yearTo = Number(input.yearTo);
  if (!make || !model || !code) throw new Error("Make, model, and generation code are required.");
  if (!Number.isInteger(yearFrom) || !Number.isInteger(yearTo) || yearFrom < 1886 || yearTo > 2100 || yearFrom > yearTo) {
    throw new Error("Enter a valid year range from 1886 to 2100.");
  }
  return { make, model, code, yearFrom, yearTo };
}

export function generationMatches(generation, vehicle) {
  const same = (a, b) => `${a ?? ""}`.trim().toLowerCase() === `${b ?? ""}`.trim().toLowerCase();
  const year = Number(vehicle.year);
  return same(generation.make, vehicle.make) && same(generation.model, vehicle.model) &&
    Number.isInteger(year) && year >= generation.yearFrom && year <= generation.yearTo;
}

export function findGeneration(generations, vehicle) {
  return generations.find((generation) => generationMatches(generation, vehicle)) ?? null;
}

export function generationId() { return createId(); }
