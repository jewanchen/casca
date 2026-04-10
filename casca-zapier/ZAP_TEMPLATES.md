# Casca Zapier — 10 Zap Templates

Submit these in the Zapier Developer Dashboard → Zap Templates section.
Each template needs: Title, Description, Trigger App, Action App, and a working Zap.

---

## Template 1: Gmail → Casca AI Summary → Slack
**Title:** Summarize new emails and post to Slack
**Description:** When a new email arrives in Gmail, Casca AI summarizes it in 3 bullet points and posts the summary to a Slack channel. Save time on email triage.
**Trigger:** Gmail → New Email
**Action 1:** Casca → Summarize Text (input: email body)
**Action 2:** Slack → Send Channel Message (input: summary)

## Template 2: Salesforce New Case → Casca AI Summary → Slack
**Title:** Auto-summarize new Salesforce cases to Slack
**Description:** When a new case is created in Salesforce, Casca AI generates a summary with issue, sentiment, and urgency. Posted to your team's Slack channel for instant awareness.
**Trigger:** Salesforce → New Record (Case)
**Action 1:** Casca → Summarize Text (input: case subject + description)
**Action 2:** Slack → Send Channel Message

## Template 3: Google Sheet Row → Casca Translate → Update Sheet
**Title:** Auto-translate Google Sheet rows
**Description:** When a new row is added to a Google Sheet, Casca AI translates a column to your target language and writes it back. Perfect for multilingual content management.
**Trigger:** Google Sheets → New Spreadsheet Row
**Action 1:** Casca → Translate Text (input: column value, target: English)
**Action 2:** Google Sheets → Update Spreadsheet Row

## Template 4: Typeform → Casca AI Chat → Google Sheet
**Title:** Analyze survey responses with AI
**Description:** When someone submits a Typeform, Casca AI analyzes the response (sentiment, key themes, action items) and logs the analysis to a Google Sheet.
**Trigger:** Typeform → New Entry
**Action 1:** Casca → AI Chat (prompt: "Analyze this survey response: {{response}}")
**Action 2:** Google Sheets → Create Spreadsheet Row

## Template 5: HubSpot New Deal → Casca AI → Gmail Draft
**Title:** AI-draft follow-up emails for new HubSpot deals
**Description:** When a new deal is created in HubSpot, Casca AI drafts a personalized follow-up email based on the deal details. Saves sales reps 15 minutes per deal.
**Trigger:** HubSpot → New Deal
**Action 1:** Casca → AI Chat (system: "You are a sales rep. Write a follow-up email.", prompt: deal details)
**Action 2:** Gmail → Create Draft

## Template 6: Intercom New Conversation → Casca Summarize → Notion
**Title:** Summarize support conversations to Notion
**Description:** When a new Intercom conversation is closed, Casca AI summarizes it and adds the summary to a Notion database for your knowledge base.
**Trigger:** Intercom → New Conversation
**Action 1:** Casca → Summarize Text
**Action 2:** Notion → Create Database Item

## Template 7: Casca Usage Alert → Slack / Email
**Title:** Get alerted when AI quota is running low
**Description:** When your Casca token usage exceeds 80% of your plan, get an alert in Slack or email. Never get surprised by overage charges.
**Trigger:** Casca → Usage Quota Alert
**Action:** Slack → Send Channel Message (or Gmail → Send Email)

## Template 8: Casca New Annotation → Slack
**Title:** Notify team when AI needs human review
**Description:** When Casca's classifier encounters an ambiguous prompt, post a notification to Slack so your team can label it. Improves routing accuracy over time.
**Trigger:** Casca → New Annotation Needed
**Action:** Slack → Send Channel Message

## Template 9: Airtable Row → Casca Generate SOQL → Airtable Update
**Title:** Convert natural language to SOQL queries
**Description:** Add a plain English question to Airtable, Casca generates the SOQL query, and writes it back. Build a queryable knowledge base for your Salesforce team.
**Trigger:** Airtable → New Record
**Action 1:** Casca → Generate SOQL Query
**Action 2:** Airtable → Update Record

## Template 10: Zendesk Ticket → Casca AI → Update Ticket
**Title:** Auto-categorize and summarize Zendesk tickets
**Description:** When a new Zendesk ticket arrives, Casca AI categorizes it (billing, technical, feature request) and adds an internal note with a summary and suggested response.
**Trigger:** Zendesk → New Ticket
**Action 1:** Casca → AI Chat (system: "Categorize this ticket and suggest a response")
**Action 2:** Zendesk → Update Ticket (add internal note)
