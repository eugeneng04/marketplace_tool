# Parser Design

## Purpose

The parser converts raw listing text into structured searchable attributes.

## Design

The parser should be category-based.

Supported categories:
- vehicle
- wheels_tires
- office_chair
- bike_part
- generic

Each parser should return:
- parsed attributes
- confidence values
- evidence text
- red flags
- positive signals

## Universal Parsed Fields

- price
- brand
- model
- condition
- color
- location
- defects
- quantity

## Parser Evidence

For every important parsed field, store:
- field
- value
- confidence
- evidenceText
- parserVersion

## Parser Versioning

The app should store parser version so old listings can be re-parsed later when the parser improves.
