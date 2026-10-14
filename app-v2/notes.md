NEW:
put the easyob link for hubspot ON THE SPECIFIC DEAL within hubspot. This also means that when you start a quote link it has to start AT THE DEAL. no deal picker and stuff.

global delay billing button, propgates only to recurring items
single billed items should be billed at checkout (confirm)
do not let discount go over 100 percent
do basic quote sanity checks (quote cannot be negative, value per month, etc.)
hide interchange plus and flat
remove the rate slider from the "with customer" view

FOR LATER: 
how do we get customers to sign new deals (upsell)
gated approval for super discounts


10/5
when you select a quote type it should default discount and delayed date 60 days (FULL POS AND FOOD TRUCK)
ask elizabeth about delaying hardware billing
ask elizabeth to mark some duplicate line items as inactive or archive. make easyob responsive to the status

make the additional software cost automatically apply based off screens that they have (anything that uses an app: POS KDS KIOSK)

10/6
swap order and pay only and all in one 

for marketing only, 2 types, pay for the hardware or not. 199 u pay for the hardware, 299 you dont have to pay for hardware

299 - 3 rbox at no cost, u get either a mega or 27 for free. 
199 - 3 rbox no cost, mega and 27 are paid


if u do website on markeitng only deals, then conditional access to order and pay + payments line item (greyed out first)
grab an affective rate from the statement they provide if there
avg ticket+volume matrix to suggest a rate, for now its flat
get rid of slider for rate, margin is not the right thing. for 2 tier u need both rates + transaction fee
95 is the default card present rate
move pricing stuff into the same panel as ticket size box



LATER:
sales commission calculator arr calculator
1 month discount option that just boosts the delay by 30 days
schedule a meeting regarding this^


10/7
per lin eitem billing delay, ask liz if we want global or per line. move it to the top

test the delay billing, end to end
mix and match delay dates and styles

pull the contacts from the deal first, then the company

add dba address

change wording for 1 of 0 in package for AMS1

everything is monthly


tablets come with additional software license



website is included with all in one, so preselect it when all in one is selected. 
swap logic needs to allow non package options as long as theyre less money, essentially as long as its under the cost of the package (before the discount)
when the AMS1 gets automatically added. Lets keep it simple. Just incriment the AMS1 along with the pos no need for all the complicated prompts regarding whats included or not. make the AMS1 selected like all the others
Kiosk will soon be renamed to be without the AMS1 so once thats done then incriment AMS1 accordingly.
highlight the items under "before you send" in big bright letters
we dont collect legal name in HS, so have user input it and sync it to HS
send legal name to the company, not the deal
group all the legal stuff together
"operating address" - are same box with tooltip
add email box for maybe a separate email - obvious
remove "what they do"
new freetext property "prev processor" put in into HS (mcc/sic as well)
"drop statement" needs to be its own box, lower, darker


10/9
Card rate minimums are needed 

 

Monthly volume should pop up with a confirmation if it seems too high 

 

All-in-one package kit doesn't show up when first checked, need to reselect for it to pop up 

 

Unit maximum should be added  

 

AMS 1 needs to show on the left side as added automatically with POS and a reminder with Kiosk to add it (because they could use the kiosk for marketing only but still need to remind them they might need it) 

 

Payroll should allow type function (so you can type 25 employees rather than clicking the add button 25 times); we should also allow the restaurant owners to edit number of employees (this might be possible already but haven't gotten that far) 

 

Automatically add in billing after “60” days for all-in-one and order/pay only. Then let them adjust if needed. Also require a long delay such as 90 days+ to be approved 

 

Website removed from All-in-one  

 

Clear cart button  

 

CFD + cash drawer + adyen should automatically add when adding in a POS and show below them for clarity  

 

Remove prices under kiosks on “marketing only – 2 year term” because they are already included the price so we dont want them to get confused even if they are shown as free on the right. Because its not a discount like the packages, its a loaned out product 

 

Discount and billing start next to each other is confusing. it looks like you are letting the discount start after “n” days 

 

Think they should not be allowed to discount the entire bill, instead only individual line items. Almost no cases where we would have a free quote so we should make it more difficult for them to do that  

 

Allow the 3 menu boards to be removed or more to be added from the marketing quotes (they have to pay if they want more but not everyone will want any or will want less than 3)  

 

Force card rates to follow decimal points “_ _ . _ _ %” so they cant accidentally make a mistake. Ex rep might write 20.00% instead of 2.0%. Same with the  $0.10 

 

Commas in monthly volume for clarity “100,000 instead of 10000”  

 

Allow customer to add more hardware when viewing the quote through easy OB. Ex. They look and realize then need an additional printer, so rather than going back to the sales rep they can add it with them.  

10/12
no plan selected at the start of a new quote — nothing highlighted, nothing in
the cart. clicking a plan is what seeds its kit / website / menu boards.
(DONE — the mount-seeding that used to do this on all_in_one is gone with it.)

marketing product boxes: the Website tile's "online ordering" checkbox was
squeezing the price into one character per line. (DONE — tiles wrap.)

10/12
make the merchant details a static card, not in drawer
(DONE — the toggle is gone; it's a card like every other panel on the page.)

pull operating addy from hubspot. its the one most likley hubspot actually carries. Then we ask for the legal addy. push it back into hs once they submit
(DONE — HubSpot's address now seeds ONLY the operating address. The merchant
details form shows Operating first and Legal second, with a "Same as operating
address" button that COPIES rather than a checkbox that silently keeps them in
step. The legal address goes back to HubSpot on the customer's onboarding
submit. NOTE: the portal carries a legal STREET and a legal CITY and no legal
state or ZIP, so only those two are written. Also fixed: createAioBusiness read
the legal address directly, which would now be blank for a merchant who paid
before onboarding — it uses locationAddress() like the location create does.)

figure out how to change quotes after publishing
edit if not signed, make a new one if alr signed
change old quote status to void (redundant confirmation)
(DEFERRED by you, 10/12. The blocker: HubSpot refuses an API edit AND an API
void on a published quote — setting hs_status: VOID is itself an edit, so both
400 LOCKED. "Edit if not signed" isn't available to us at all; the only shape
this can take is "publish a replacement, void the old one by hand in HubSpot".)

matrix table, editable
(DONE — §10.3 of the pricing guide, the $0.15/txn card, 9 volume bands × 9
ticket columns. Admin → Settings → Rate matrix, shown as the same table with
every cell editable and a save button. It SUGGESTS: a rep can type over it, and
a quote with no volume/ticket on file still gets the flat 2.49% default. CNP is
one flat editable number for now, DEFAULTED TO 3.30% per the guide — that is a
change from today's 2.49%, and it's one box to change.)

when quote is confirmed "payment_processing_arr" in hs = margin x monthly volume x 12
not needed for marketing only.
(DONE — written on the deal at ACCEPTANCE, never before: this feeds total_arr,
which the sales org reads as booked revenue. Omitted rather than zeroed for
marketing-only and for a quote with no volume.)

for online ordering there should be a separate matrix, but dont put it back into hubspot because website arr is not important
(NOT BUILT — you chose "keep CNP flat for now". The one flat number is on the
same admin page; when it becomes a grid it takes the CP grid's shape.)

block quote creations for when deal stage is past "close won" or just add diologue box
(DONE, and it was a real hole: AIO's pipeline runs Onboarding, Configuration,
Deployment/Training and Deal Active AFTER Closed Won, and HubSpot flags all four
closed:false — so the existing "is it closed" check waved every one of them
through. Closed Won itself still confirms rather than refuses.)

LATER: comissions calculator, write to HS


Elizabeth notes: 

Limit quantity if marketing products too 
(DONE — both Marketing Kits capped at 6; they were the only uncapped family.)

Dont allow more Customer Facing Displays/Cash drawer than POS units 
(DONE — RELATIVE_CEILINGS. Counted against both POS SKUs, reported not clamped.)

Dont allow more adyen’s than POS units/kiosks  (we should put kiosk separate from adyen and have them automatically add too with kiosks) 
(CEILING DONE — AMS1 <= POS + kiosks. The auto-add half is NOT done: it needs the
27"/Mini SKUs renamed in HubSpot first, or it double-bills the terminal already in
the box, and it reverses the 10/9 "reminder on kiosks" decision.)

Delete tablet options. I dont think we have any reason to offer them unless we can think of a use case where they should be allowed.  Maybe in marketing ony package if they add in online ordering. --> online ordering will need some other hardware options too with marketing only 
(DONE as a SWITCH, default off — Admin → Quote limits → "Products offered".
Hidden from the picker, never refused, and one already on a quote stays visible.
The marketing/online-ordering hardware question is still open.)

Fix formatting on billing start date, year gets cut off
(DONE — the date fields shared the number inputs' 5.5rem width.)

Marketing 2 year term: only allow either 27inch kiosk or mega kiosk. dont allow both or more than one  
(DONE — exactly one, either kind. Refused, not comped.)

Categorize the “AIO tableside POS” as a product and “website” as a software (this has been moved on hubspot already) 
(NOT MOVED — checked live 10/12: both still have an empty hs_product_type, so both
sit under "Uncategorized" in the picker. EasyOB reads the type straight off
HubSpot, so this is two field edits in the portal, no code change.)


Add a section to make notes. Can we make it so that the sales person can add notes that are automatically added in hubspot about certain things. Like if they make the delayed billing longer than 60 days, force them to leave a note explaining why and tagging me automatically  
(DONE — note box under the billing controls, required past 60 days, posted to the
deal and OWNED by Elizabeth. Not an @mention: this portal's NOTE object has no
hs_at_mentioned_owner_ids, so the API can't raise that notification — a HubSpot
workflow on "note created, owner = Elizabeth" would. Needs crm.objects.notes.write
on the EasyOB Billing app or every push 403s.)


10/13
make quote publish as soon as link is sent
make llc blank
make operating addy checkbox again
DBA should not go back and rewrite the company name
add email to owner contact - dropdown for exisitng or make a new one add to hs
add billing contact - same thing
overwrite the billing conact in hs. 
elizabeth update category types for uncategeorized
can the email go through the sales rep?
ordering points must show up on quote
make avg ticket writeable like volume (i should just be able to type in to in and how delete the old value of 0.00), no arrows
commissions calculator
lock cnp rates
get rid of the dual rate (amex)
retire the "drop statement" make sure the cnp rate hows as whats locked in the settings
make matrix bucketing explicit
get rid of the "use it" and make it always override
the only thing to display from the cole message is the margin, cuz thats how reps see their commission. the other stuff calculate it and store it in an admin only view somewhere
"hardware comissions" underneath pkage saings and discounts, this can go negatice
make discounts also a subtraction
switch to product library

immediatley work on payments stuff
make sure value writes back to payments ARR hubspot property (payment_processing_arr) OVERWRITES
make sure the quote email sends

Total Revenue  = (CP Rate * VolMon) + ((VOlMon/Avg Ticket) * Txn Fee)
Total Take Rate = Total Revenue / Monthly Volume
Margin = Total Take Rate %  - Whole %
Wholesale % is 


Avg Ticket 

$10 

$15 

$20 

$25 

$30 

$40 

$50 

$75 

$100 

Total Wholesale % 

3.50% 

2.87% 

2.55% 

2.36% 

2.23% 

2.08% 

1.98% 

1.85% 

1.79% 

 
10/14
Can you say "Billing Contact" and subheader that says "This is where your
invoices will be emailed to"
(DONE — the section is "Billing Contact" with that line under it. It sits in
the CONTENT column, not under the label: at >=64rem the label column is 8.5rem
and would wrap that sentence to five lines.)

compact the cp and cnp rate its spaced out for no reason
(DONE — the inputs were width:100% inside two fractional columns, so a
four-character number stretched across a quarter of the panel. Fixed widths,
lanes at their natural size. Also removed a `styles.brand` wrapper that
referenced a class which doesn't exist — it had been rendering class="undefined".)

remove the bucket "$75K – $100K a month at a $20+ ticket"
(DONE — and with it the whole "Rate card:" row. Note this REVERSES 10/13's
"make matrix bucketing explicit": that grey line WAS the explicit bucketing.
Without it the row showed the same two numbers as the boxes directly above —
the card always overrides now, so those boxes ARE the rate card. RateSuggestion
is still mounted and still applies; it just renders nothing.)

add the phrase "per transaction" after the rate
(DONE — in both rate boxes and on the document preview. Also replaced "/txn"
on the wizard's rate cards and the exported proposal, so there's one wording.)

add a cash discount option for each line item
(DONE, then REBUILT the same day after you pointed out HubSpot takes cash
discounts natively — you were right and the first version was bad. It
converted your dollars into a percentage, because I believed
`hs_discount_percentage` was the only discount HubSpot would accept. It
isn't. The conversion meant a figure you typed could not actually be billed:
$100 off a $749 line became 13.4% and charged $100.37, and the box you typed
$100 into settled to $100.37 in front of you.

Now the dollars ARE the stored figure. Two things I had to prove first,
because the portal couldn't: HubSpot's `discount` property is PER UNIT (all
166 live line items carrying one have quantity 1, where both readings look
identical), and it keeps six decimals while rounding the TOTAL. So we store
the line total you type and divide once at the boundary —
`scripts/probe-cash-discount.ts` is the proof and is worth keeping.

Verified end to end against live HubSpot through the real code path: $100 off
3 × $749, $747 off 3 × $749, $1,000 off 7 × $999.99, $12.34 off one. All four
match to the cent.

The percentage box stays for "give them 20% off" and still rounds to one
decimal, which costs nothing now. Typing in either box clears the other. The
cap applies to both — $700 off a $749 line is 93% and would otherwise have
walked straight around the admin limit. Your merchant's quote prints
"$747.00 off", not the percentage it works out as.)

confirm we are adding a payments line item on the hubspot quote
(IT WASN'T, on most quotes. Checked the live portal: the $0 "AIO Processing
Two Tiered Rate" line went on MARKETING quotes with online ordering only —
never on all_in_one / order_pay_only — so on a normal POS quote the rates were
written NOWHERE on the document the merchant signs. And its text was the
product's own STATIC description, which still reads 2.49% / 3.50% plus the
AMEX split you retired on 10/13, to every merchant alike.
DONE — it now goes on every quote AIO processes for, and the line item carries
THIS merchant's rates in its own description. Two things worth knowing: a
RATE-ONLY quote is explicitly guarded and still derives no lines at all, and a
quote saved BEFORE today has no such line until someone reopens and re-saves
it — publish sends quoteLines verbatim.
NOTE: every processing quote now hard-blocks if that SKU leaves the catalog.
Same posture the marketing case already had.)

get rid of the card present rate for online-ordering-only
(DONE, with a note explaining why. The predicate is deliberately not
"marketing + a website": marketing_term INCLUDES a kiosk, and a kiosk takes a
card in person. It also isn't ordering points alone — the AMS1 is a card
reader that counts zero points.
AND the money followed the display: we assume 95% card-present on a
no-statement quote, so hiding the lane alone would have left the merchant's
own headline effective rate 95% weighted on a rate we'd just said can never
apply. That blend, the rep's margin preview and the floor check now use 0.)

keep consistent language around card present / card not present
(DONE — "in person"/"online" is gone from both places it appeared, and
"V/MC/Disc Not Present" is now "V/MC/Disc Card Not Present".)

"same as owner contact" should hide the dropdown too
(DONE — and it was more than untidy. Checking the box already cleared the
picked contact id, because "same as owner" silently PATCHing someone's HubSpot
contact record is exactly what that clearing prevents — but the picker stayed
live, so a rep could re-pick one while checked and put the form straight back
into that state. The whole grid goes now; the summary line stands in for it.)
