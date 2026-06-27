from . import __version__ as app_version

app_name = "smart_bank_reconciliation"
app_title = "Smart Bank Reconciliation"
app_publisher = "akashnerella@gmail.com"
app_description = "An app for Auto Bank Reconciliation"
app_icon = "octicon octicon-file-directory"
app_color = "grey"
app_email = "akashnerella@gmail.com"
app_license = "MIT"

# Includes in <head>
# ------------------

# include js, css files in header of desk.html
# app_include_css = "/assets/smart_bank_reconciliation/css/smart_bank_reconciliation.css"
# app_include_js = "/assets/smart_bank_reconciliation/js/smart_bank_reconciliation.js"

# include js, css files in header of web template
# web_include_css = "/assets/smart_bank_reconciliation/css/smart_bank_reconciliation.css"
# web_include_js = "/assets/smart_bank_reconciliation/js/smart_bank_reconciliation.js"

# include custom scss in every website theme (without file extension ".scss")
# website_theme_scss = "smart_bank_reconciliation/public/scss/website"

# include js, css files in header of web form
# webform_include_js = {"doctype": "public/js/doctype.js"}
# webform_include_css = {"doctype": "public/css/doctype.css"}

# include js in page
# page_js = {"page" : "public/js/file.js"}

# include js in doctype views
# doctype_js = {"doctype" : "public/js/doctype.js"}
# doctype_list_js = {"doctype" : "public/js/doctype_list.js"}
# doctype_tree_js = {"doctype" : "public/js/doctype_tree.js"}
# doctype_calendar_js = {"doctype" : "public/js/doctype_calendar.js"}

# Home Pages
# ----------

# application home page (will override Website Settings)
# home_page = "login"

# website user home page (by Role)
# role_home_page = {
#	"Role": "home_page"
# }

# Generators
# ----------

# automatically create page for each record of this doctype
# website_generators = ["Web Page"]

# Installation
# ------------

# before_install = "smart_bank_reconciliation.install.before_install"
# after_install = "smart_bank_reconciliation.install.after_install"

# Uninstallation
# ------------

# before_uninstall = "smart_bank_reconciliation.uninstall.before_uninstall"
# after_uninstall = "smart_bank_reconciliation.uninstall.after_uninstall"

# Desk Notifications
# ------------------
# See frappe.core.notifications.get_notification_config

# notification_config = "smart_bank_reconciliation.notifications.get_notification_config"

# Permissions
# -----------
# Permissions evaluated in scripted ways

# permission_query_conditions = {
#	"Event": "frappe.desk.doctype.event.event.get_permission_query_conditions",
# }
#
# has_permission = {
#	"Event": "frappe.desk.doctype.event.event.has_permission",
# }

# DocType Class
# ---------------
# Override standard doctype classes

# override_doctype_class = {
#	"ToDo": "custom_app.overrides.CustomToDo"
# }

# Document Events
# ---------------
# Hook on document methods and events

# doc_events = {
#	"*": {
#		"on_update": "method",
#		"on_cancel": "method",
#		"on_trash": "method"
#	}
# }

# Scheduled Tasks
# ---------------

# scheduler_events = {
#	"all": [
#		"smart_bank_reconciliation.tasks.all"
#	],
#	"daily": [
#		"smart_bank_reconciliation.tasks.daily"
#	],
#	"hourly": [
#		"smart_bank_reconciliation.tasks.hourly"
#	],
#	"weekly": [
#		"smart_bank_reconciliation.tasks.weekly"
#	]
#	"monthly": [
#		"smart_bank_reconciliation.tasks.monthly"
#	]
# }

# Testing
# -------

# before_tests = "smart_bank_reconciliation.install.before_tests"

# Overriding Methods
# ------------------------------
#
# override_whitelisted_methods = {
#	"frappe.desk.doctype.event.event.get_events": "smart_bank_reconciliation.event.get_events"
# }
#
# each overriding function accepts a `data` argument;
# generated from the base implementation of the doctype dashboard,
# along with any modifications made in other Frappe apps
# override_doctype_dashboards = {
#	"Task": "smart_bank_reconciliation.task.get_dashboard_data"
# }

# exempt linked doctypes from being automatically cancelled
#
# auto_cancel_exempted_doctypes = ["Auto Repeat"]

# Request Events
# ----------------
# before_request = ["smart_bank_reconciliation.utils.before_request"]
# after_request = ["smart_bank_reconciliation.utils.after_request"]

# Job Events
# ----------
# before_job = ["smart_bank_reconciliation.utils.before_job"]
# after_job = ["smart_bank_reconciliation.utils.after_job"]

# User Data Protection
# --------------------

user_data_fields = [
	{
		"doctype": "{doctype_1}",
		"filter_by": "{filter_by}",
		"redact_fields": ["{field_1}", "{field_2}"],
		"partial": 1,
	},
	{
		"doctype": "{doctype_2}",
		"filter_by": "{filter_by}",
		"partial": 1,
	},
	{
		"doctype": "{doctype_3}",
		"strict": False,
	},
	{
		"doctype": "{doctype_4}"
	}
]

# Authentication and authorization
# --------------------------------

# auth_hooks = [
#	"smart_bank_reconciliation.auth.validate"
# ]

