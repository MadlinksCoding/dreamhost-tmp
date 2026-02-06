Main Class File to Integrate Utilities Into: @file
Utility Folder Location: @file
Utility Classes: ErrorHandler, Logger, SafeUtils, ConfigFileLoader, DateTime

YOUR PURPOSE
Read and understand all the utility files in the utility folder, along with the Main Class File (the Logger class is very long and you only need to understand writeLog and debugLog). Then, for each method in the Main Class File, ensure all five utility classes are integrated correctly and fully, based on the rules and conditions provided for each utility class below.

INSTRUCTIONS
Go through one method at a time in the Main Class File. This means for one method only you run the audit and then the integration of all utility and guidelines according to the rules below.
Before marking the method as updated, you must confirm that each utility and its specific rules have been applied and fully adhered to.
You must not summarize what you’ve done.
You must initially create a sanity_to_do.md file in the same folder as the main class file to write reminders into.
Always start from the top method and work down, one by one.
Skip methods that will be replaced, such as a method that we will use from the utils.
You must respond with the following only: “Method update – press ‘y’ to proceed with the next method.”

Each utility class has its own rules and instructions as follows below:

ERRORHANDLER UTILITY RULES:
Remove any existing error-handling code, including outdated handlers, and ensure ErrorHandler is used correctly and consistently throughout each method.
If ErrorHandler is missing where needed, add it. If a method is already correct or doesn’t require error handling, skip it automatically.
Refactor all existing error logic to use ErrorHandler exclusively—remove any custom error functions, wrappers, or duplicated try/catch blocks used solely for formatting or logging. If you remove any redundant error handlers, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.
Replace any legacy or outdated uses of ErrorHandler with the current API, and ensure no legacy handling methods remain.
Every time an error is thrown, it must be immediately preceded by ErrorHandler.addError(...). Do not define error messages outside of usage or use const error = new Error(...). Optionally include metadata such as category and severity.
Example usage:
ErrorHandler.addError(`Config file not found: ${resolvedConfigFilePath}`, {
  code: "FILE_NOT_FOUND",
  origin: "ConfigSchemaLoader",
  data: data,
});
throw new Error(`Config file not found: ${resolvedConfigFilePath}`);

SAFEUTILS UTILITY RULES:
As the first line in any method using input validation - even before try catch, you must call SafeUtils.sanitizeValidate() and clearly specify whether each input field is required or not. This method is the standard for validation and takes priority over all others.
Remove any existing custom or ad-hoc sanitization, validation, or parsing logic, and replace it with the appropriate SafeUtils method. No wrappers, manual regex, trimming, escaping, or custom “sanitizeX” functions are allowed. If you remove any redundant sanitizer or validator methods, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.
Use sanitizeValidate() wherever applicable; only use hasValue() in edge cases where field presence must be checked without type enforcement.
Replace unsafe or duplicate logic such as Number(), Boolean(), parseInt(), parseFloat(), direct regex checks, query parsing, or object coercion with the correct SafeUtils method.
If SafeUtils cannot replicate the exact behavior of the original logic, retain the original code but include a comment noting that the original must remain because SafeUtils does not support that use case.
Ensure all untrusted inputs (e.g., params, payloads, headers, queries, external data) are sanitized or validated using the correct SafeUtils method. Treat null, false, or empty values as invalid where appropriate.
If outdated SafeUtils patterns or methods are in use, update them to match the current API.
Example usage (must be first line in method):
const cleaned = SafeUtils.sanitizeValidate({
  transaction_id: { value: transaction_id, type: "string", required: true },
  amount: { value: amount, type: "float", required: true },
  is_active: { value: is_active, type: "boolean", required: false, default: false },
});

Other SafeUtils methods (to be used after sanitizeValidate() where needed):
const cleaned = SafeUtils.hasValue(inputText) ? SafeUtils.sanitizeTextField(inputText) : null;
const cleaned = SafeUtils.sanitizeTextField(inputText);
const safeEmail = SafeUtils.sanitizeEmail(emailCandidate);
const safeUrl = SafeUtils.sanitizeUrl(urlCandidate);
const safeInt = SafeUtils.sanitizeInteger(limitCandidate);
const safeBool = SafeUtils.sanitizeBoolean(flagCandidate);

DATETIME UTILITY RULES:
Remove any existing date/time logic where appropriate, and ensure DateTime is used consistently and correctly in every method. If DateTime is missing but needed, add it. If the method already uses DateTime properly or doesn’t require date/time handling, skip it automatically.
Refactor all date/time logic to use the DateTime class exclusively—no use of native Date, Moment, Luxon, manual parsing, formatting, or calculations. Wrapper functions, helpers, or duplicate implementations (public, private, or static) are not allowed. f you remove any redundant date time handlers, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.
Always use DateTime.now() to retrieve the current time. It ensures a consistent format and respects the default timezone configured in the DateTime class.
Replace any of the following with appropriate DateTime methods: parsing dates, formatting, time differences, date range checks, timezone conversion, or generating relative time strings.
If DateTime cannot replicate the behavior of existing code exactly, retain the original code and add an IMPORTANT comment explaining why it must remain.
Example usage:
const now = DateTime.now();
const ts = DateTime.parseDateToTimestamp("2026-01-05 13:10:00");
const pretty = DateTime.formatPrettyRelativeTime(ts);
const isFuture = DateTime.isFuture("2026-01-10 09:00:00");
const hkToLocal = DateTime.convertHongKongToLocal("2026-01-05 10:00:00", "Australia/Brisbane");

CONSOLE LOGS VIA LOGGER DEBUGLOG() RULES:
Remove all console.log statements and replace them with Logger.debugLog?.(...). This includes any variant such as console.error, console.warn, or console.info.
Use Logger.debugLog?.(...) at the start of every method to log method entry, and also before and after key actions such as data updates, transformations, handling of payloads, and return statements.
All debug messages must follow this format:
 [Class] [Method] [Action] Your message
Any object included in a message must be stringified using JSON.stringify(...) or similar.
Remove and replace any existing logger methods that are not Logger.debugLog. f you remove any redundant console handlers, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.
Example usage:
Logger.debugLog?.(`[UserService] [createUser] [TRANSACTIONS] Failed to create user: ${err.message}`);
Logger.debugLog?.(`[OrderController] [submitOrder] [START] Payload received: ${JSON.stringify(payload)}`);
Logger.debugLog?.(`[AuthService] [validateToken] [SUCCESS] Token validated for user ID: ${userId}`);

LOGGER UTILITY RULES:
If logging with Logger.writeLog() is missing where required, add it. 
All logging must use Logger.writeLog() with no wrapper or alternate implementations. Replace any custom or ad-hoc logging and remove any public, private, or static logging helpers and replace them with direct calls to Logger.writeLog(). If you remove any redundant logger handlers, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.
Do NOT add try catch to writeLog()
The flag used in Logger.writeLog() must match the class name in uppercase (e.g., class ModerationService must use flag "MODERATIONS"). 
The action field must be provided for every log. If the critical field needs to be overridden, do so per usage. Critical is typically true for critical failures.
Example – writeLog usage:
Logger.writeLog({
  flag: "MODERATIONS",
  action: "mediaApproved",
  data: {
    moderationId: id,
    approvedby: userId,
    ipAddress: (typeof IP_ADDRESS === "string" && IP_ADDRESS.trim())
      ? IP_ADDRESS.trim()
      : "No IP"
  }
});

CONFIG FILE LOADER UTILITY RULES:
If any method loads config files directly (JSON, YAML, INI, etc.), replace that logic with ConfigFileLoader.
Locate all direct config file loads and refactor them to use ConfigFileLoader.loadConfig(...) exclusively. No other file loading functions, custom loaders, wrappers, or static helpers are allowed. Since ConfigFileLoader already handles caching and sanity checks internally, remove any utility functions or manual logic that attempt to perform these tasks separately. No additional caching layers, sanity validation, or file existence checks are needed.If you remove any redundant config handlers, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.
Remove any ad-hoc or manual implementations used for reading config files (e.g., fs.readFile, require(), third-party parsers, etc.). Replace them with a call to ConfigFileLoader.If you remove any redundant config handlers, create / update a sanity check to do list md file with a note to delete the old handler class and update usage accordingly.


Example usage:
const envConfig = ConfigFileLoader.loadConfig("./configs/envConfig.json");

PART 2 GUIDELINES
1.
For all constants (e.g., environment variables, config values, injected params):
Check for truthy existence before referencing or using the constant.


Never use fallbacks (e.g., const port = config.port || 3000 is not allowed).


Throw an error if a required constant is missing.


Example (correct usage):
if (!config.port) {
  throw new Error("Missing required config value: port");
}
const serverPort = config.port;

2.
There is no need to check conditions like if (DateTime && typeof DateTime.now === "function").
Assume utility is always available and correctly implemented. Remove any such checks from the code.

3.
Always throw an error inside every } catch (error) { block. Do not silently catch or log without re-throwing.

4.
Remove all snake_case naming unless it is critically required (e.g., by an external system or data structure). Replace all internal variables, parameters, and constants with camelCase.


