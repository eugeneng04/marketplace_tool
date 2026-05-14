# Modification Parser Design

## Purpose

Detect vehicle modifications from listing descriptions.

## Modification Categories

- engine
- turbo_supercharger
- intake_exhaust
- tune_ecu
- suspension
- wheels_tires
- brakes
- clutch_transmission
- interior
- exterior
- audio
- safety
- emissions_risk
- unknown

## Example Modifications

- coilovers
- lowered
- catback exhaust
- headers
- intake
- K&N intake
- Hondata
- KPro
- Cobb
- APR tune
- aftermarket wheels
- roll cage
- bucket seats
- big brake kit
- short shifter
- engine swap

## Risk Flags

- straight pipe
- catless
- no smog
- track car
- rebuilt engine
- engine swap
- salvage
- back fees
- needs tune
- check engine light
- transmission slipping
- overheating
- does not run
- mechanic special

## Stored Data

Each detected modification should store:
- modType
- modName
- brand
- confidence
- evidenceText

## Valuation Impact

Clean OEM:
- strong comp match

Tasteful reversible mods:
- neutral or small positive

Heavy performance mods:
- increased uncertainty

Emissions-risk mods:
- strong penalty, especially in California/local-market searches
