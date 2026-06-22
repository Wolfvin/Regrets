-- haskell_runner_template.hs — template for the generated Main.hs runner.
--
-- Placeholders (substituted by capture_haskell.sh via sed):
--   __MODULE_NAME__       → the module name (e.g. "StringUtils")
--   __STRING_DISPATCH__   → the dispatch clause for string inputs
--   __INT_DISPATCH__      → the dispatch clause for int inputs
--   __MULTI_DISPATCH__    → the dispatch clause for multi-arg (array) inputs
--
-- The generated Main.hs:
--   1. imports __MODULE_NAME__ (qualified as M)
--   2. reads a JSON value from stdin
--   3. dispatches to M.<entry> based on the JSON type
--   4. prints the JSON-encoded result to stdout

import qualified __MODULE_NAME__ as M
import Data.Char (isDigit, isSpace)

-- ─── Minimal JSON value type ────────────────────────────────────────────────
data JSON = JString String | JInt Integer | JBool Bool | JArray [JSON] | JNull deriving (Show, Eq)

-- ─── Minimal JSON parser (handles strings, ints, arrays) ────────────────────
parseJSON :: String -> Maybe JSON
parseJSON s =
  case runParser value (dropWhile isSpace s) of
    Just (v, _) -> Just v
    Nothing -> Nothing

-- A simple parser: returns (value, remaining input) or Nothing
type Parser a = String -> Maybe (a, String)

value :: Parser JSON
value s =
  case s of
    ('"' : rest) -> do
      let (str, rest') = parseStr rest
      return (JString str, rest')
    ('[' : rest) -> array (dropWhile isSpace rest)
    ('t' : 'r' : 'u' : 'e' : rest) -> Just (JBool True, rest)
    ('f' : 'a' : 'l' : 's' : 'e' : rest) -> Just (JBool False, rest)
    (c : _)
      | c == '-' || isDigit c ->
          let numStr = takeWhile (\x -> isDigit x || x == '-') s
              rest' = drop (length numStr) s
          in Just (JInt (read numStr :: Integer), rest')
    _ -> Nothing

parseStr :: String -> (String, String)
parseStr [] = ("", [])
parseStr ('"' : rest) = ("", rest)
parseStr ('\\' : c : rest) =
  let (s', rest') = parseStr rest
  in (c : s', rest')
parseStr (c : rest) =
  let (s', rest') = parseStr rest
  in (c : s', rest')

array :: Parser JSON
array (']' : rest) = return (JArray [], rest)
array s = do
  (v, rest) <- value s
  let rest' = dropWhile isSpace rest
  case rest' of
    (',' : rest'') -> do
      (JArray vs, rest''') <- array (dropWhile isSpace rest'')
      return (JArray (v : vs), rest''')
    (']' : rest'') -> return (JArray [v], rest'')
    _ -> Nothing

runParser :: Parser a -> String -> Maybe (a, String)
runParser p s = p s

-- ─── JSON encoder ───────────────────────────────────────────────────────────
encodeJSON :: JSON -> String
encodeJSON (JString s) = '"' : concatMap esc s ++ "\""
  where
    esc '"' = "\\\""
    esc '\\' = "\\\\"
    esc '\n' = "\\n"
    esc '\t' = "\\t"
    esc c = [c]
encodeJSON (JInt n) = show n
encodeJSON (JBool True) = "true"
encodeJSON (JBool False) = "false"
encodeJSON (JArray xs) = "[" ++ intercalate "," (map encodeJSON xs) ++ "]"
encodeJSON JNull = "null"

intercalate :: String -> [String] -> String
intercalate _ [] = ""
intercalate _ [x] = x
intercalate sep (x:xs) = x ++ sep ++ intercalate sep xs

-- ─── Dispatch tables (substituted by capture_haskell.sh) ────────────────────
dispatchString :: String -> JSON
__STRING_DISPATCH__

dispatchInt :: Integer -> JSON
__INT_DISPATCH__

dispatchMulti :: [JSON] -> JSON
__MULTI_DISPATCH__

-- ─── Main: read JSON from stdin, dispatch, print result ─────────────────────
main :: IO ()
main = do
  input <- getContents
  case parseJSON input of
    Nothing -> putStrLn "null"
    Just (JString s) -> putStrLn (encodeJSON (dispatchString s))
    Just (JInt n) -> putStrLn (encodeJSON (dispatchInt n))
    Just (JArray args) -> putStrLn (encodeJSON (dispatchMulti args))
    Just JNull -> putStrLn "null"
