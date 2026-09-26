import test from "node:test";
import assert from "node:assert/strict";
import { SUGGESTED_GENERATIONS, findGeneration, generationMatches, validateGeneration } from "../src/vehicleGenerations.js";
import { createVehicleGeneration, listVehicleGenerations, updateVehicleGeneration, deleteVehicleGeneration } from "../src/db.js";

test("suggested BMW, Porsche, and Honda generation ranges resolve by make, model, and year", () => {
  assert.equal(findGeneration(SUGGESTED_GENERATIONS, { make: "BMW", model: "M3", year: 2011 }).code, "E90");
  assert.equal(findGeneration(SUGGESTED_GENERATIONS, { make: "BMW", model: "M3", year: 2004 }).code, "E46");
  assert.equal(findGeneration(SUGGESTED_GENERATIONS, { make: "Porsche", model: "911", year: 2016 }).code, "991");
  assert.equal(findGeneration(SUGGESTED_GENERATIONS, { make: "Porsche", model: "Cayman", year: 2018 }).code, "982 / 718");
  assert.equal(findGeneration(SUGGESTED_GENERATIONS, { make: "Honda", model: "Civic", year: 2008 }).code, "8th gen");
  assert.equal(findGeneration(SUGGESTED_GENERATIONS, { make: "BMW", model: "M3", year: 2020 }), null);
  assert.equal(generationMatches(SUGGESTED_GENERATIONS[0], { make: "bmw", model: "m3", year: 1999 }), true);
});

test("manual generation year ranges are validated", () => {
  assert.deepEqual(validateGeneration({ make: " Nissan ", model: "Skyline", code: "R32", yearFrom: "1989", yearTo: "1994" }), {
    make: "Nissan", model: "Skyline", code: "R32", yearFrom: 1989, yearTo: 1994
  });
  assert.throws(() => validateGeneration({ make: "BMW", model: "M3", code: "bad", yearFrom: 2000, yearTo: 1999 }), /valid year range/);
});

test("vehicle generation catalog supports create, edit, list, and delete", async () => {
  const rows = new Map();
  const db = { pool: { async query(sql, values = []) {
    if (sql.startsWith("INSERT INTO vehicle_generations")) {
      const row = { id: values[0], make: values[1], model: values[2], code: values[3], year_from: values[4], year_to: values[5], source: "manual" };
      rows.set(row.id, row); return { rows: [row] };
    }
    if (sql.includes("SET source='hidden'")) return { rowCount: 0 };
    if (sql.startsWith("UPDATE vehicle_generations")) {
      const row = rows.get(values[0]); if (!row) return { rows: [] };
      Object.assign(row, { make: values[1], model: values[2], code: values[3], year_from: values[4], year_to: values[5], source: "manual" });
      return { rows: [row] };
    }
    if (sql.startsWith("SELECT * FROM vehicle_generations")) return { rows: [...rows.values()] };
    if (sql.startsWith("DELETE FROM vehicle_generations")) return { rowCount: Number(rows.delete(values[0])) };
    throw new Error(`Unexpected SQL: ${sql}`);
  } } };
  const created = await createVehicleGeneration(db, { make: "Nissan", model: "Skyline", code: "R32", yearFrom: 1989, yearTo: 1994 });
  assert.equal(created.source, "manual");
  const updated = await updateVehicleGeneration(db, created.id, { make: "Nissan", model: "Skyline GT-R", code: "R32", yearFrom: 1989, yearTo: 1994 });
  assert.equal(updated.model, "Skyline GT-R");
  assert.equal((await listVehicleGenerations(db)).length, 1);
  assert.equal(await deleteVehicleGeneration(db, created.id), true);
  assert.equal(await deleteVehicleGeneration(db, created.id), false);
});
