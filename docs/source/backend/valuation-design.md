# Valuation Design

## Purpose

Estimate whether a listing is a good deal using local Marketplace asking-price data.

## MVP Scope

MVP valuation uses Facebook Marketplace asking prices only.

## Future Scope

Future valuation should include sold comps from:
- Cars & Bids
- Bring a Trailer
- eBay sold listings

## Outputs

The valuation engine should output:
- estimated local asking value range
- price score
- listing quality score
- deal score
- confidence level
- explanation list

## Vehicle Scoring Factors

Positive:
- below local median
- clean title
- manual transmission, if desired
- reasonable mileage
- recent price drop
- good description detail

Negative:
- salvage title
- rebuilt title
- no title
- missing mileage
- automatic when manual desired
- heavy modifications
- emissions-risk modifications
- no smog
- check engine light
- does not run

## Example Output

Asking price: $8,500  
Estimated local asking value: $7,200–$8,800  
Deal score: 84/100  
Quality score: 76/100  
Price score: 91/100  
Verdict: Fair price, but verify smog and title.
