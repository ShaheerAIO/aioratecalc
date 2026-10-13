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

 