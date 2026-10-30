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
(DONE — an "Amount off" $ box beside "Percent off" in each line's drawer.
Nothing new is stored: it computes the percent, because the percent is the
only lever that reaches HubSpot. The base respects "applies to N of qty".
Under it the drawer now states the REAL net — "3 × $749.00 → $1,500.00" —
because a percentage can't always land exactly on a dollar figure and the
document can't be amended once published.
CLOSED by limiting every percent to ONE DECIMAL (your call, same day) — a
tenth is unarguably safe in HubSpot, so the open question about
`hs_discount_percentage`'s precision no longer blocks anything. Applies to
hand-typed percents too, so it's true of the line and not just of the dollar
box. The cost: a dollar figure usually can't be hit exactly. $747 off $2,247
stores 33.2% and bills $1,501.00, and the box you typed $100 into settles to
$100.37. Both figures are shown rather than hidden.)

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



card proc two lines
lizzy note on the deal


10/15
dont allow the montly revenue to be less than 10 dollars
show montly revenue and yearly arr in the card rate box
dont allow rep to change CP rate to make monthly rev less than 10$
move monthly volume and avg ticket to sit above the rates in the "card rate" card
(DONE earlier today — on /rep/prospects/new, the one surface where those two are
editable next to the rates. EditQuotePanel has no such boxes, and PricingStep
collects them a step earlier.)
if billing delay is not 60 days that should force rep to put note as well


move dba to the top
(DONE — DBA is now the first thing asked on every form that asks it: its own
section above Operating on the rep's merchant details, and first in the grid on
the review panel, ApplyStep, the customer's confirmation step and the customer
onboarding step.)

remove years open
(DONE — gone from all five forms. The field STAYS on the BusinessInfo type:
saved rows carry it and prefillMerge still lists it as something HubSpot can't
know. What's gone with the boxes: its entry in CONFIRMABLE_PATHS — a public
lead token had been allowed to write a field nobody can type any more — its
label, its row in the customer's "My Data" summary, and its slot in the rep
form's completeness counter, which would otherwise have counted a field that
can never be filled.)

aio, order n pay, marketing should be the order of the packages
(DONE — All-in-One, Order & Pay Only, Marketing Only, Marketing 2-Year. Third
reversal of this order (10/6 → 10/13 → 10/15); the array's comment carries the
history. QUOTE_TYPES is the only positional consumer — the labels elsewhere are
id-keyed, so nothing else moved.)

add floor for rate (wholesale + minimum), editable in settings
(BUILT, SHIPPED SWITCHED OFF — your call, same day. The floor is
wholesalePctFor(avgTicket) + an admin minimum in bps, editable at Admin →
Quote limits, refused server-side in assertRateAboveFloor beside the other two
floors. It is a THIRD floor: the margin floor is revenue over interchange and
padded and secret; the $10/mo floor is wholesale margin in dollars; this one is
the same wholesale basis expressed as a RATE, so it binds on a merchant of any
size where the $10 only binds on small ones. Open and unpadded like the $10 —
the refusal names the minimum rate.
WHY IT'S OFF: 0 bps is NOT the inert default it looks like. It means "never
below wholesale", and AIO's own §10.3 rate card sits below the wholesale table
in 48 of its 81 cells — every ticket from $10 to $50 once a merchant is over
$75K/mo, by as much as 133bps. The card is built on margin over INTERCHANGE,
the wholesale table is the flat ticket-indexed figure you gave on 10/13 for
commission/ARR, and wholesale.ts already says the two "will not agree, and are
not supposed to". This floor is the first thing that would have made them
agree, silently, by refusing the rate the card itself suggests. So blank = off,
a number turns it on, and the number is yours to pick once you decide which
basis is the truth. Migration 0026 — the column is nullable for that reason.)

Instead of of adding a "in package" chip group them all under one "in package" banner or header thingy
(DONE — covered lines come out of the itemized one-time list and sit under one
banner per package, "{name} — already paid for, in the package", each with its
qty and struck-through MSRP. The "In plan" chip STAYS a chip: it marks a single
derived line, and a banner over one row reads worse than the chip did.
Found while doing it: the document layout already printed "{package} covers
{list}" per applied package, and that list was one GLOBAL string — with two
packages applied it printed every covered item under BOTH names. Deleted; the
new banner says it per group, correctly.)

make "QSR kit" pop
make all the headers pop
(DONE — package names move onto the display font at 800, so "QSR Kit" stops
reading as body text beside its own price; section headings go to 1.25rem with
tighter tracking and the document layout's headings match them; picker group
labels come up from --ink-3 to --ink-2 for contrast.
Worth knowing: QSR Kit is ACTIVE and the styling is generic, not special-cased
to that name. CLAUDE.md still says the kit ships inactive because its HubSpot
record is $0 — that is stale. The $0 SKU is a vestigial HARDWARE_BUNDLES entry
from the pre-10/08 design; today's kit has no HubSpot product at all, it IS the
real hardware lines at 100% off. Same expression as the comped install.)

make max discounts per line item instead of a global. Put this next to the quote limits
(DONE — "Discount caps" sits directly under "Unit caps" on Admin → Quote limits,
one cap per product, same jsonb shape and same blank-means-default behaviour.
The old single "Maximum discount" is KEPT and relabelled "Default discount cap":
a product with no cap of its own has to be limited by something, and that number
is still the approval lever — raising it is how a discount over 50% gets granted.
The blocker now names WHICH cap it hit, so a rep knows whether to ask for this
product or for the default. The cash-dollar lever is converted against the list
amount and held to the same per-product cap, so the $ box can't walk around it.
Migration 0025.)

you cannot discount the plan
(DONE — any discount on the plan line is refused outright, percent or dollars,
and the discount controls are hidden from its drawer. The BILLING START control
stays: the plan line is exactly the line that carries the 60-day delay, so
removing the whole drawer would have taken that with it. Keyed to the plan id
the quote resolves NOW, not to isPlatformProduct — a retired platform line is
always dropped and re-derived on reopen, so a legacy row can't become
unsavable. One real edge: a quote saved earlier WITH a discount on the current
plan product shows the blocker on reopen and the rep clears it.)


fix email template, dont say that they can reply to it cuz i dont know where those replies go. Put a big heading saying they cant reply to the email. (or tell me if its possible to read the emails somewhere or we can forward them to certain people i have powershell access with admin)
(ANSWERED, then DONE the other way — your call, same day. The replies DO have a
known destination, in two cases. When resolveReplyToRep could verify the owning
rep (10/13), Reply-To is set to that rep's own address and a reply lands in
their mailbox — that promise is true and is kept. When it couldn't, there is no
Reply-To at all, so a reply goes to aiodocuments@aioapp.com, a real shared
mailbox in the tenant that you can grant access to or forward with PowerShell.
So no "do not reply" heading: the one branch that was lying — "Questions? Just
reply to this email" with no Reply-To behind it — now points at the link and at
their AIO representative instead.)


the quote preview is too cluttered — make the different types (monthly and one
time) contained in boxes/bubbles so its obvious, non-tech people use this
(DONE — each billing type is now its own bordered card with a tinted header
bar: periwinkle for monthly, neutral for one-time, the group total set large
enough to read before any line under it, and a plain-English line saying WHEN
it is charged ("charged once, at checkout"). They had been told apart only by
a small grey word and a hairline, which is the single most expensive thing on
this screen to misread.
Also: "Billing starts 60 days after checkout" was printing under EVERY monthly
line. When every line in the group starts together it is now said once, in the
header. It goes back to per-line the moment the starts differ — which is the
only case where anyone has to compare them.)


Customer portal:
get rid of the whole rate breakdown in the customer preview of the quote just show the line items
(DONE — the effective-rate / annual-savings hero and the whole stat ticker are
gone from QuoteSummary, which is the ONE component behind both the public
/lead/[token]/quote page and the authenticated "Your Quote" tab. The note under
it explaining what the rate was priced on went too — it only existed to explain
a number that is no longer there. The rates still reach the merchant on the
document they actually sign: the $0 disclosure line added on 10/14 carries
THIS merchant's rates in its own description.)

for "ongoing" rename it to software
(DONE — the heading and the footnote under the lines.)

block the preview by package and  not package
(DONE — covered lines are lifted out of the one-time list and grouped under
"Included in your {package}". A covered line reads as its struck-through MSRP
and the word "Included" rather than a $0.00 charge, which is what a package
actually is. Only one-time lines group: package coverage never applies to a
recurring line, so "Software" is untouched. "Total due once" is unchanged —
it comes from the server's own charged-only total.)


1. The chips — PLAN, IN PLAN, COMPED, CARD RATES, PRE-AUTH are five different vocabularies on one screen. COMPED in particular means nothing to a non-technical reader; "Free" or "Included" would. That's a copy decision, not a layout one, so I didn't guess.
(DONE — "Included", your call, 10/16. COMPED and INCLUDED had been two chips
for one fact: a $0 line is a $0 line whether a policy comp put it there or the
plan did. Now one word, and it takes the green the comped chip had, which is
the same green IN PLAN already wears — so the screen says "AIO gives this
away" in one colour and one word however it came about. `isCompedService`
still decides the MONEY; only the label merged.)
2. The n/a commission cells on the Processing and Pre-Auth rows — they're structural noise on lines that can never carry commission. Could be blank instead.
(DONE — and it was worse than noise. Those two were falling into the `no_cost`
status, which is a live warning that somebody should go and price a product in
HubSpot — so they also appeared in the AE's "not counted, no cost or rate yet"
footnote and in the admin Commissions gaps panel, as two products to go and
fix that can never be fixed and never should be. They now carry their own
status (`isNotCommissionable`): the cell is blank, both lists drop them, and
"n/a" is left meaning the one thing it should — a real product nobody has
entered a cost for yet.)

10/16
swappability is now gone from the qsr kit. return the swapping functionality. I
should be able to swap KDS, POS, KIOSK interchangibly. The catch is that any
swap costs the "free kit replacement item" line item per swap.
remove FKRI from the line items in the picker thats not needed it should be
automatic
(DONE — and it was a real refusal, not a missing feature. A cart line could
only take a kit slot that cost AT LEAST as much as the line did, so swapping
DOWN worked and swapping UP was refused in silence: drop the KDS and add a
second POS and the POS ($949 sheet, $735 slot) was simply charged at $749 with
no blocker, no label and nothing saying why. A second Kiosk 27" was $1,495 the
same way.
Four screens — POS, KDS, Kiosk 27", Kiosk 15.6" — now fill each other's slots
in either direction with no price test at all. The MEGA KIOSK is deliberately
not one of them: $2,700 into a $735 slot is $1,965 that a $400 charge does not
come close to covering, so it keeps the old ceiling along with the tableside
device, the printer and anything off the sheet. The locked items (display,
terminal, drawer, menu board, WiFi) are untouched.
EVERY swap is charged, including the cheaper stand-ins that were free before —
one rule a rep can say out loud. So a second KDS standing in for a POS went
from free to $400; nothing already published moves, because a published quote
carries its saved lines verbatim.
THE KIOSK NEEDED ONE MORE THING. The kiosk SKUs are a kiosk and an AMS1 welded
together and the kit holds only two terminal seats — one for the POS's loose
terminal, one for the kiosk that comes in the kit. So a second kiosk always
arrives with a third terminal, and "covered whole or not at all" would have
left the entire $1,495 line charged over $350 of it. The terminal is now seated
nowhere and counted, and the merchant is charged one AMS1 for it: $400 + $350 =
$750, which is exactly what a second POS already costs, whose loose AMS1 is
charged for the same reason. That AMS1 line carries a new `derived` flag and is
the only derived line on a product a rep can also pick by hand — without it,
reopening the quote would read it back as a pick, both terminal seats would
fill with loose terminals, and the kiosk they had just been charged for would
stop being covered. Reopen is verified stable.
Both charges are DERIVED AND UNTOUCHABLE, the same posture as the $0.50
pre-auth: not pickable, not discountable, not removable, no drawer on the row.
The way to clear them is to put the cart back. If that discretion is ever
wanted, the per-product discount cap from 10/15 is one edit away.
"Free Kit Replacement Item" is off the picker as asked. One flag: that name
reads oddly on the document a merchant signs, and the HubSpot product name is
what publishes — renaming it is a portal-side change, not a code one.)

QUOTE BUILDER:
instgallation is priced and training, Included but priced. treat it like a regular line item.
menu board is not a screen, dont count it.
you can only swap KDS Kiosk and POS with each other in the qsr kit. Everything else gets added normally
no payroll without point of sale

QUOTE PREVIEW FOR CUSTOMER:
separate card for payment details
show cnp cp rates on quote prev, make cp smaller, show volume
chargeback fees 25, retrieval fee 15, 
add descriptions for all line items

CONFRIM INFO SCREEN:
change street and operating to legal and DBA
(DONE 10/18 —
Install + training: charged at list, still auto-added, discountable like any
line. COMPED_SERVICE_PRODUCT_IDS is empty; every new hardware quote is $1,498
more than yesterday. Already-published quotes don't move.
Menu board: no longer counts toward the four included screens.
Kit swaps: ONLY POS / KDS / Kiosk 27" / Kiosk 15.6" swap with each other. The
old "anything cheaper can take a dearer slot" rule is gone — a printer,
tableside, mPOS or tablet is now just charged. Mega Kiosk still can't swap.
Payroll: blocked unless a counter POS is on the quote (POS Unit, POS w/ CFD,
POS Dual Screen). mPOS/tableside/kiosks don't count.
Customer quote: new "Payment Details" card — card-present rate as the
headline, card-not-present smaller under it, monthly volume, chargeback $25,
retrieval $15. Every line has a one-sentence description, written in
lib/lineDescriptions.ts (HubSpot's catalog text is untouched).
Confirm screen: "Registered/Operating" → "Legal/DBA".)



10/21
remove wifi packages - remove all the individual unifi items. The package line item name "aio wifi package" is supposed to just represent all the individual items. also make sure that shows up on the builder side as well so that they can remove it if need be

no 0-9.99

add basis point adjustment

DBA and operating addy are the same hting

Entity type, state, zip are required
Llc needs to be all caps 
Remove hard language when user is accepting quote after the verifying info stage. it makes it seem like they can negotiate. Plain and simple "continue" button. Make sure to keep the diologue box about it taking a while to generate the quote

we need to add the foodbuy form to hubspot. When someone fills it out it should put it in the files for that company in hubspot

make the buckets match with the new doc

/Users/shaheerhasnain/Downloads/10.2026_AIO-Restaurant-Payment-Pricing-Guide.pdf


write the whole percent range instead of bps
make the ui just silelenty locked to the range for adjusting the cp rate


10/28

installation should be automatically discounted to 100% off

when u select MPO, there should be big chips for kiosk, online ordering, and marketing. that will autoselect the stuff accordingly. hide the marketing(partial ordering) line item it will confuse people. Just have it silently added if they click the marketing chip.

cant get negative comission off discounting the onboarding and installation

the rep should be able to give the kiosk away for free in the qsr package, but if they want to charge for it they also should be able to. add a little button that allows them to charge it

need to remove the ui for "how would u like to pay" because the payment plans for the invoice come through klarna at checkout. Check if there is uncommitted work already fixing this.


10/29
45 day default billing delay
bolden card processing header
discounting first kiosk does not remove comission
cannot loose money on discounting install and obt if they discount it to 0. but they get comission if they charge for it
lower comission rate for the first kiosk, 45 & 5

customer facing view:
make cp smaller
billing contact first for customer end (confirm details page)
turn off klarna keep affirm
5% cc charge
print summary, add it to deal attatchment
licenses => ordering points change terminology
remove payroll from subscription box make it its own box
move the payment details box to the bottom



10/30
quote picker:
move payroll line item to the top, as a toggle
remove marketing button from MPO (autoselect it, cannot be changed) - the reason for this is that if someone wants kiosk and online ordering without marketing they can select order and pay and just remove the POS its still 299

header for payment details should be bolder for customer facing quote prev
when quote get sent, move deal stage to "quote sent" (if deal is in sales meeting 1 or 2)