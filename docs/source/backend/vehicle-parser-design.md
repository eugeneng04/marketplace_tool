# Vehicle Parser Design

## Purpose

Parse vehicle-specific details from listing titles and descriptions.

## Parsed Fields

- year
- make
- model
- trim
- generation
- bodyStyle
- mileage
- transmission
- drivetrain
- engine
- fuelType
- titleStatus
- color
- VIN
- smogStatus
- registrationStatus
- condition

## Transmission Parsing

Manual examples:
- manual
- stick shift
- 5 speed
- 5-speed
- 6 speed
- 6spd
- standard transmission
- mt

Automatic examples:
- automatic
- auto
- cvt
- dsg
- pdk

False positives to avoid:
- manual windows
- manual seats
- manual locks
- owner's manual

## Title Status Parsing

Examples:
- clean title
- salvage title
- rebuilt title
- branded title
- lien sale
- bill of sale only
- no title
- missing title

## Mileage Parsing

Examples:
- 120k
- 120,000 miles
- 120000 mi
- odo 89k
- mileage: 145,321

## Smog and Registration

Detect:
- smogged
- passes smog
- no smog
- needs smog
- back fees
- registration expired
- tags current

## Condition Signals

Positive:
- clean title
- maintenance records
- one owner
- stock
- smogged
- new tires
- recent service

Negative:
- check engine light
- overheating
- transmission slipping
- does not run
- mechanic special
- salvage
- back fees
