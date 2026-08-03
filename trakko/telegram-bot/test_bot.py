import asyncio
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import bot


class PhoneNormalizationTests(unittest.TestCase):
    def test_bot_username_diagnostic_explains_invalid_values(self):
        diagnostic = bot._telegram_bot_username_diagnostic(
            "@Tokko Shopper",
            "env.TELEGRAM_BOT_USERNAME",
        )
        self.assertFalse(diagnostic["valid"])
        self.assertFalse(diagnostic["endsWithBot"])
        self.assertFalse(diagnostic["allowedCharacters"])
        self.assertEqual(diagnostic["preview"], "Tokko?Shopper")

    def test_bot_username_resolver_prefers_runtime_bot_username(self):
        telegram_bot = SimpleNamespace(username="@TokkoShopperBot")
        with patch.dict(
            os.environ,
            {"TELEGRAM_BOT_USERNAME": "Invalid Display Name"},
        ):
            username = asyncio.run(bot._resolve_telegram_bot_username(
                telegram_bot,
                trace_id="trace-runtime",
                required=True,
            ))
        self.assertEqual(username, "TokkoShopperBot")

    def test_bot_username_resolver_uses_get_me_after_invalid_env(self):
        telegram_bot = SimpleNamespace(
            username=None,
            get_me=AsyncMock(return_value=SimpleNamespace(username="TokkoLiveBot")),
        )
        with patch.dict(
            os.environ,
            {"TELEGRAM_BOT_USERNAME": "Tokko display name"},
        ):
            username = asyncio.run(bot._resolve_telegram_bot_username(
                telegram_bot,
                trace_id="trace-get-me",
                required=True,
            ))
        self.assertEqual(username, "TokkoLiveBot")
        telegram_bot.get_me.assert_awaited_once()

    def test_normalizes_telegram_contact(self):
        self.assertEqual(bot._normalize_phone("91 98765-43210"), "+919876543210")

    def test_carousel_markup_navigation_bounds(self):
        product = {
            "choiceId": "12345678-1234-1234-1234-123456789012",
            "available": True,
        }
        first = [b.text for row in bot._ucp_carousel_markup(product, 0, 3).inline_keyboard for b in row]
        self.assertNotIn("‹ Prev", first)
        self.assertIn("Next ›", first)
        self.assertIn("✓ Select this product", first)
        last = [b.text for row in bot._ucp_carousel_markup(product, 2, 3).inline_keyboard for b in row]
        self.assertIn("‹ Prev", last)
        self.assertNotIn("Next ›", last)
        blocked = [b.text for row in bot._ucp_carousel_markup({"choiceId": "", "available": False}, 0, 1).inline_keyboard for b in row]
        self.assertNotIn("✓ Select this product", blocked)

    def test_expands_indian_local_dependent_number(self):
        self.assertEqual(
            bot._normalize_dependent_phone("9900112233", "+919876543210"),
            "+919900112233",
        )

    def test_rejects_invalid_number(self):
        with self.assertRaises(ValueError):
            bot._normalize_phone("123")

    def test_validates_and_normalizes_mandate_amount(self):
        self.assertEqual(bot._valid_mandate_amount("₹500"), "500.00")
        self.assertEqual(bot._valid_mandate_amount("750.50"), "750.50")
        self.assertIsNone(bot._valid_mandate_amount("0"))
        self.assertIsNone(bot._valid_mandate_amount("50.999"))

    def test_understands_typed_definitive_answers(self):
        self.assertIs(bot._confirmation_answer("yes, approve"), True)
        self.assertIs(bot._confirmation_answer("Go ahead"), True)
        self.assertIs(bot._confirmation_answer("No, leave it"), False)
        self.assertIsNone(bot._confirmation_answer("show me milk"))

    def test_builds_one_checkbox_for_each_saved_address(self):
        addresses = [
            {
                "id": "101",
                "label": "Home",
                "formattedAddress": "Home: 12 Park Street, Kolkata 700016",
            },
            {
                "id": "202",
                "label": "Parents",
                "formattedAddress": "Parents: 8 Lake Road, Kolkata 700029",
            },
        ]
        markup = bot._address_selection_markup(addresses)
        self.assertEqual(len(markup.inline_keyboard), 3)
        self.assertEqual(
            markup.inline_keyboard[0][0].callback_data,
            "address:select:101",
        )
        self.assertEqual(markup.inline_keyboard[-1][0].callback_data, "address:add")
        self.assertIn("12 Park Street", bot._address_list_text(addresses))
        self.assertIn("8 Lake Road", bot._address_list_text(addresses))

    def test_parses_any_two_letter_address_country_code(self):
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: Parents | IN | 12 Park Street, Kolkata 700016"
            ),
            ("Parents", "IN", "12 Park Street, Kolkata 700016"),
        )
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: Home | US | 123 Main Street, New York, NY 10001"
            ),
            ("Home", "US", "123 Main Street, New York, NY 10001"),
        )
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: London | gb | 10 Downing Street, London SW1A 2AA"
            ),
            ("London", "GB", "10 Downing Street, London SW1A 2AA"),
        )
        self.assertEqual(
            bot._parse_tokko_address_text(
                "Address: Parents | 12 Park Street, Kolkata 700016",
                "IN",
            ),
            ("Parents", "IN", "12 Park Street, Kolkata 700016"),
        )

    def test_address_country_picker_has_presets_and_other(self):
        markup = bot._address_country_markup()
        callbacks = [
            button.callback_data
            for row in markup.inline_keyboard
            for button in row
        ]
        self.assertIn("address:country:IN", callbacks)
        self.assertIn("address:country:US", callbacks)
        self.assertIn("address:country:OTHER", callbacks)
    def test_exposes_address_commands_and_keyboard_actions(self):
        commands = {entry.command for entry in bot.BOT_COMMANDS}
        self.assertTrue({"addresses", "reselect", "addaddress"}.issubset(commands))
        keyboard_labels = {
            button.text
            for row in bot.MAIN_KEYBOARD.keyboard
            for button in row
        }
        self.assertIn("Addresses", keyboard_labels)
        self.assertIn("Add Address", keyboard_labels)

    def test_legacy_multi_merchant_cart_is_blocked_from_checkout(self):
        text = bot._ucp_cart_text({
            "itemCount": 2,
            "merchantGroups": [{
                "merchant": "oziva",
                "merchantName": "OZiva",
                "items": [{"productName": "Plant Protein", "quantity": 1}],
                "subtotals": [{"currency": "INR", "amount": "999.00"}],
            }, {
                "merchant": "himalayawellness",
                "merchantName": "Himalaya Wellness",
                "items": [{"productName": "Neem Face Wash", "quantity": 1}],
                "subtotals": [{"currency": "INR", "amount": "199.00"}],
            }],
        })
        self.assertIn("OZiva", text)
        self.assertIn("Himalaya Wellness", text)
        self.assertIn("legacy cart mixes merchants", text)
        self.assertIsNone(bot._ucp_cart_checkout_markup({
            "merchantGroups": [{"merchant": "oziva"}, {"merchant": "himalayawellness"}],
        }))

    def test_cart_markup_uses_typed_removal_instead_of_item_buttons(self):
        markup = bot._ucp_cart_checkout_markup({
            "items": [{"id": "42", "productName": "Neem Shampoo"}],
            "merchantGroups": [{"merchant": "himalayawellness", "merchantName": "Himalaya"}],
        })
        callbacks = [button.callback_data for row in markup.inline_keyboard for button in row]
        labels = [button.text for row in markup.inline_keyboard for button in row]
        self.assertNotIn("cart:remove:42", callbacks)
        self.assertIn("cart:empty", callbacks)
        self.assertIn("cart:checkout:himalayawellness", callbacks)
        self.assertIn("Proceed to Checkout", labels)
        self.assertIn("remove <product name>", bot._ucp_cart_text({
            "itemCount": 1,
            "items": [{"id": "42", "productName": "Neem Shampoo"}],
            "merchantGroups": [{
                "merchant": "himalayawellness",
                "merchantName": "Himalaya",
                "items": [{"productName": "Neem Shampoo", "quantity": 1}],
            }],
        }))

    def test_cart_checkout_uses_live_checkout_result_without_missing_order_routes(self):
        result = bot._ucp_checkout_hermes_result({
            "merchantName": "Himalaya Wellness",
            "currency": "INR",
            "totalAmount": "547.00",
            "totals": [{"type": "total", "amountMinor": 54700}],
            "paymentRoute": "merchant_checkout",
            "merchantHandoffUrl": "https://merchant.example/checkouts/secure-1",
        })
        self.assertEqual(
            result["nextAction"]["url"],
            "https://merchant.example/checkouts/secure-1",
        )
        self.assertEqual(result["checkoutSummary"]["totalAmount"], "547.00")
        self.assertNotIn("confirmationRequired", result["checkoutSummary"])

        card_result = bot._ucp_checkout_hermes_result({
            "merchantName": "Himalaya Wellness",
            "currency": "INR",
            "totalAmount": "547.00",
            "paymentRoute": "card_selection_required",
            "cardChoices": [{"token": "choice", "last4": "4242"}],
        })
        self.assertIsNone(card_result["nextAction"])
        self.assertEqual(card_result["cardChoices"][0]["last4"], "4242")

        approval_result = bot._ucp_checkout_hermes_result({
            "orderId": "11111111-1111-4111-8111-111111111111",
            "merchantName": "Himalaya Wellness",
            "currency": "INR",
            "totalAmount": "563.41",
            "shippingAmount": "49.00",
            "forexAmount": "16.41",
            "approvalRequired": True,
            "merchantHandoffUrl": None,
        })
        self.assertIsNone(approval_result["nextAction"])
        self.assertTrue(
            approval_result["checkoutSummary"]["confirmationRequired"]
        )
        self.assertIn("3% forex charge", approval_result["message"])

        payment_options = {
            "type": "prava_payment_options",
            "label": "Use another payment method with Prava",
            "url": "https://tokko-shopper.vercel.app/api/payments/telegram/options?state=signed",
        }
        payment_result = bot._ucp_checkout_hermes_result({
            "merchantName": "Himalaya Wellness",
            "currency": "INR",
            "totalAmount": "547.00",
            "paymentRoute": "mandate_selection_required",
            "merchantHandoffUrl": "https://merchant.example/checkouts/secure-2",
            "nextAction": payment_options,
        })
        self.assertEqual(payment_result["nextAction"], payment_options)

        prava_approval = {
            "type": "prava_card_approval",
            "label": "Pay with Prava",
            "url": "https://checkout.prava.space/session/secure-2",
        }
        direct_result = bot._ucp_checkout_hermes_result({
            "merchantName": "Himalaya Wellness",
            "currency": "INR",
            "totalAmount": "547.00",
            "paymentRoute": "prava_card",
            "merchantHandoffUrl": "https://merchant.example/checkouts/secure-2",
            "nextAction": prava_approval,
        })
        self.assertEqual(direct_result["nextAction"], prava_approval)
        self.assertIn("secure Prava payment link", direct_result["message"])

    def test_proceed_to_checkout_starts_a_direct_prava_payment_session(self):
        query = SimpleNamespace(
            data="cart:checkout:himalayawellness",
            answer=AsyncMock(),
            message=SimpleNamespace(reply_text=AsyncMock()),
        )
        update = SimpleNamespace(
            callback_query=query,
            effective_chat=SimpleNamespace(id=1234),
            effective_message=query.message,
        )
        context = SimpleNamespace(bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        order_id = "11111111-1111-4111-8111-111111111111"
        quote = {"orderId": order_id, "approvalRequired": True}
        approval = {
            "merchantName": "Himalaya Wellness",
            "currency": "INR",
            "totalAmount": "547.00",
            "paymentRoute": "prava_card",
            "nextAction": {
                "type": "prava_card_approval",
                "label": "Pay securely with Prava",
                "url": "https://checkout.prava.space/session/direct-1",
            },
        }
        family_api = AsyncMock(side_effect=[quote, approval])
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "_telegram_return_context", AsyncMock(return_value={
                "returnContext": {
                    "channel": "telegram",
                    "botUsername": "TokkoShopperBot",
                },
            })),
            patch.object(bot, "_family_api", family_api),
            patch.object(bot, "_send_hermes_result", AsyncMock()) as send_result,
        ):
            asyncio.run(bot.checkout_ucp_merchant_cart(update, context))

        self.assertEqual(family_api.await_count, 2)
        self.assertEqual(
            family_api.await_args_list[0].args,
            (
                binding,
                "POST",
                "merchants/ucp/cart/checkout",
                {"merchant": "himalayawellness"},
            ),
        )
        self.assertEqual(
            family_api.await_args_list[1].args,
            (
                binding,
                "POST",
                f"merchants/ucp/orders/{order_id}/decision",
                {
                    "proceed": True,
                    "paymentFlow": "prava_direct_card",
                    "returnContext": {
                        "channel": "telegram",
                        "botUsername": "TokkoShopperBot",
                        "chatId": "1234",
                    },
                },
            ),
        )
        sent_result = send_result.await_args.args[1]
        self.assertEqual(
            sent_result["nextAction"]["url"],
            "https://checkout.prava.space/session/direct-1",
        )
        self.assertNotEqual(
            sent_result["nextAction"].get("type"),
            "merchant_ucp_checkout",
        )

    def test_checkout_approval_requests_the_telegram_linq_payment_policy(self):
        query = SimpleNamespace(
            data="ucporder:yes:11111111-1111-4111-8111-111111111111",
            answer=AsyncMock(),
            edit_message_text=AsyncMock(),
            message=SimpleNamespace(reply_text=AsyncMock()),
        )
        update = SimpleNamespace(
            callback_query=query,
            effective_chat=SimpleNamespace(id=1234),
            effective_message=query.message,
        )
        context = SimpleNamespace(bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        checkout = {
            "paymentRoute": "mandate_selection_required",
            "nextAction": {"type": "prava_payment_options", "url": "https://example.test"},
        }
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "_telegram_return_context", AsyncMock(return_value={
                "returnContext": {
                    "channel": "telegram",
                    "botUsername": "TokkoShopperBot",
                },
            })),
            patch.object(bot, "_family_api", AsyncMock(return_value=checkout)) as family_api,
            patch.object(bot, "_send_hermes_result", AsyncMock()) as send_result,
        ):
            asyncio.run(bot.decide_ucp_order(update, context))

        family_api.assert_awaited_once_with(
            binding,
            "POST",
            "merchants/ucp/orders/11111111-1111-4111-8111-111111111111/decision",
            {
                "proceed": True,
                "paymentFlow": "prava_mandate_selection",
                "cardChoiceMode": "saved_or_different",
                "returnContext": {
                    "channel": "telegram",
                    "botUsername": "TokkoShopperBot",
                    "chatId": "1234",
                },
            },
        )
        send_result.assert_awaited_once()

    def test_shopping_message_requires_session_address_confirmation(self):
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            message=SimpleNamespace(text="find plant protein"),
        )
        context = SimpleNamespace(user_data={}, bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "get_pending_action", AsyncMock(return_value=None)),
            patch.object(bot, "_offer_address_or_ready", AsyncMock()) as offer,
            patch.object(bot, "_call_hermes", AsyncMock()) as hermes,
        ):
            asyncio.run(bot.handle_message(update, context))
        offer.assert_awaited_once()
        hermes.assert_not_awaited()

    def test_direct_product_search_uses_the_same_hermes_flow_as_other_messages(self):
        message = SimpleNamespace(text="find milk")
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )
        context = SimpleNamespace(user_data={}, bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        search_result = {"message": "i found products from himalaya's live ucp"}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "get_pending_action", AsyncMock(return_value=None)),
            patch.object(bot, "_address_session_confirmed", AsyncMock(return_value=True)),
            patch.object(bot, "_keep_typing", AsyncMock()),
            patch.object(bot, "_call_hermes", AsyncMock(return_value=search_result)) as hermes,
            patch.object(bot, "_send_hermes_result", AsyncMock()) as send_result,
            patch.object(bot, "_family_api", AsyncMock()) as family_api,
        ):
            asyncio.run(bot.handle_message(update, context))
        hermes.assert_awaited_once_with(
            1234,
            binding,
            "find milk",
            telegram_bot=context.bot,
        )
        send_result.assert_awaited_once_with(update, search_result, binding)
        family_api.assert_not_awaited()

    def test_new_request_clears_cart_from_replaced_approval_context(self):
        message = SimpleNamespace(text="find vitamin c", reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )
        context = SimpleNamespace(user_data={}, bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        pending = {"token": "old-token", "description": "unfinished checkout"}
        search_result = {"message": "fresh results"}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "get_pending_action", AsyncMock(return_value=pending)),
            patch.object(bot, "_address_session_confirmed", AsyncMock(return_value=True)),
            patch.object(bot, "_clear_abandoned_cart", AsyncMock(return_value={})) as clear_cart,
            patch.object(bot, "_keep_typing", AsyncMock()),
            patch.object(bot, "_call_hermes", AsyncMock(return_value=search_result)) as hermes,
            patch.object(bot, "_send_hermes_result", AsyncMock()),
        ):
            asyncio.run(bot.handle_message(update, context))
        clear_cart.assert_awaited_once_with(1234, binding)
        hermes.assert_awaited_once_with(
            1234,
            binding,
            "find vitamin c",
            telegram_bot=context.bot,
        )

    def test_start_opens_a_fresh_session_with_an_empty_cart(self):
        message = SimpleNamespace(reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            message=message,
        )
        context = SimpleNamespace(
            args=[],
            user_data={},
            bot=SimpleNamespace(set_my_commands=AsyncMock()),
        )
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        with (
            patch.dict(os.environ, {"VERCEL": ""}),
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "_clear_abandoned_cart", AsyncMock(return_value={})) as clear_cart,
            patch.object(bot, "_offer_address_or_ready", AsyncMock()) as offer,
        ):
            result = asyncio.run(bot.start(update, context))
        self.assertEqual(result, bot.ConversationHandler.END)
        clear_cart.assert_awaited_once_with(1234, binding)
        offer.assert_awaited_once_with(update, binding, "You're connected to Tokko.")

    def test_mandate_return_resumes_the_same_checkout_conversation(self):
        message = SimpleNamespace(reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )
        context = SimpleNamespace(
            args=["payments_mandate_return"],
            user_data={},
            bot=SimpleNamespace(set_my_commands=AsyncMock()),
        )
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        checkout_result = {
            "message": "The new mandate was automatically used for this cart.",
            "credentialIssued": True,
        }
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "_call_hermes", AsyncMock(return_value=checkout_result)) as hermes,
            patch.object(bot, "_send_hermes_result", AsyncMock()) as send_result,
            patch.object(bot, "_family_api", AsyncMock()) as family_api,
        ):
            result = asyncio.run(bot.start(update, context))

        self.assertEqual(result, bot.ConversationHandler.END)
        hermes.assert_awaited_once_with(
            1234,
            binding,
            text="/start payments_mandate_return",
            telegram_bot=context.bot,
        )
        send_result.assert_awaited_once_with(update, checkout_result, binding)
        family_api.assert_not_awaited()

    def test_successful_prava_return_sends_merchant_failure_as_immediate_followup(self):
        message = SimpleNamespace(reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )
        asyncio.run(bot._send_hermes_result(
            update,
            {
                "message": "Prava checkout was successful, but the order still awaits merchant approval. This cart was cleared.",
                "credentialIssued": True,
                "followupMessage": "Order creation failed at the merchant end.",
            },
            {"userId": 42},
        ))
        self.assertEqual(message.reply_text.await_count, 2)
        sent = [call.args[0] for call in message.reply_text.await_args_list]
        self.assertIn("Prava checkout was successful", sent[0])
        self.assertNotIn("transaction", sent[0].lower())
        self.assertEqual(sent[1], "Order creation failed at the merchant end.")

    def test_mandate_summary_only_shows_top_five(self):
        mandates = [
            {
                "id": f"mandate-{index}",
                "status": "active",
                "merchantName": f"Merchant {index}",
                "currency": "INR",
                "approvedAmount": str(index * 100),
                "remaining": str(index * 100),
            }
            for index in range(1, 8)
        ]
        message = bot._mandates_text(mandates, total_count=7, has_more=True)
        self.assertIn("Top Prava mandates: 5", message)
        self.assertIn("Merchant 5", message)
        self.assertNotIn("Merchant 6", message)
        self.assertIn("Showing 5 of 7", message)
        self.assertIn("Show All (30 Days)", message)

    def test_mandate_history_shows_all_records_returned_for_month(self):
        mandates = [
            {
                "id": "mandate-1",
                "status": "active",
                "merchantName": "Kapiva",
                "currency": "INR",
                "approvedAmount": "100",
                "remaining": "80",
                "updatedAt": "2026-08-01T12:00:00.000Z",
            },
            {
                "id": "mandate-2",
                "status": "paused",
                "merchantName": "OZiva",
                "currency": "INR",
                "approvedAmount": "500",
                "remaining": "500",
                "createdAt": "2026-07-15T12:00:00.000Z",
            },
        ]
        message = bot._mandates_text(mandates, history=True)
        self.assertIn("last 30 days: 2", message)
        self.assertIn("Kapiva", message)
        self.assertIn("OZiva", message)
        self.assertIn("activity: 2026-08-01", message)

    def test_any_merchant_mandate_is_labeled_without_a_fake_merchant(self):
        message = bot._mandates_text(
            [{
                "id": "mandate-any",
                "status": "active",
                "merchantScope": "any",
                "merchantName": "Tokko Health & Wellness",
                "currency": "INR",
                "approvedAmount": "1000",
                "remaining": "1000",
                "frequency": "one_time",
            }]
        )
        self.assertIn("Any merchant", message)
        self.assertNotIn("Tokko Health & Wellness", message)


class OnboardingRedirectTests(unittest.TestCase):
    def test_unknown_phone_redirects_to_hosted_onboarding(self):
        message = SimpleNamespace(
            contact=SimpleNamespace(user_id=99, phone_number="+919876543210"),
            reply_text=AsyncMock(),
        )
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_user=SimpleNamespace(id=99),
            message=message,
        )
        context = SimpleNamespace(user_data={"onboarding": {"legacy": True}})

        with patch.object(bot, "_lookup_family", AsyncMock(return_value=None)):
            result = asyncio.run(bot.handle_contact(update, context))

        self.assertEqual(result, bot.ConversationHandler.END)
        self.assertNotIn("onboarding", context.user_data)
        reply_markup = message.reply_text.await_args.kwargs["reply_markup"]
        button = reply_markup.inline_keyboard[0][0]
        self.assertEqual(button.text, "Complete Tokko onboarding")
        self.assertEqual(button.url, "https://tokko-drab.vercel.app")

    def test_completed_family_keeps_existing_connection_flow(self):
        binding = {
            "userId": 42,
            "customerId": "tokko_family_42",
            "familyPhone": "+919876543210",
            "profileComplete": True,
        }
        message = SimpleNamespace(
            contact=SimpleNamespace(user_id=99, phone_number="+919876543210"),
            reply_text=AsyncMock(),
        )
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_user=SimpleNamespace(id=99),
            message=message,
        )
        context = SimpleNamespace(user_data={})

        with (
            patch.object(bot, "_lookup_family", AsyncMock(return_value=binding)),
            patch.object(bot, "set_family_binding", AsyncMock()) as save_binding,
            patch.object(bot, "_offer_address_or_ready", AsyncMock()) as offer_address,
        ):
            result = asyncio.run(bot.handle_contact(update, context))

        self.assertEqual(result, bot.ConversationHandler.END)
        save_binding.assert_awaited_once_with(1234, binding)
        offer_address.assert_awaited_once_with(
            update,
            binding,
            "Found your family account. You're connected to Tokko.",
        )
        message.reply_text.assert_not_awaited()


class BindingPersistenceTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_path = bot.DB_PATH
        bot.DB_PATH = os.path.join(self.temp_dir.name, "bridge.db")
        bot._init_db()

    def tearDown(self):
        bot.DB_PATH = self.original_path
        self.temp_dir.cleanup()

    def test_round_trips_tokko_user_binding(self):
        binding = {
            "userId": 42,
            "customerId": "tokko_family_42",
            "familyPhone": "+919876543210",
            "responseLanguage": "bn-IN",
        }
        asyncio.run(bot.set_family_binding(1234, binding))
        self.assertEqual(asyncio.run(bot.get_family_binding(1234)), binding)

    def test_round_trips_and_clears_pending_hermes_approval(self):
        action = {
            "token": "signed-approval-token",
            "description": "add milk to the cart",
            "expiresInSeconds": 600,
        }
        asyncio.run(bot.set_pending_action(1234, action))
        saved = asyncio.run(bot.get_pending_action(1234))
        self.assertEqual(saved["token"], action["token"])
        self.assertEqual(saved["description"], action["description"])
        asyncio.run(bot.clear_pending_action(1234))
        self.assertIsNone(asyncio.run(bot.get_pending_action(1234)))

    def test_round_trips_saved_card_choices_without_storing_card_numbers(self):
        choices = [{
            "token": "signed-card-choice",
            "brand": "visa",
            "last4": "4242",
            "isDefault": True,
        }]
        bot._set_pending_ucp_cards_sync(1234, choices)
        saved = bot._get_pending_ucp_card_sync(1234, 0)
        self.assertEqual(saved, choices[0])
        bot._clear_pending_ucp_cards_sync(1234)
        self.assertIsNone(bot._get_pending_ucp_card_sync(1234, 0))

    def test_clears_all_local_state_for_abandoned_shopping_context(self):
        bot._set_pending_action_sync(1234, {
            "token": "signed-approval-token",
            "description": "checkout",
            "expiresInSeconds": 600,
        })
        bot._set_pending_ucp_cards_sync(1234, [{
            "token": "signed-card-choice",
            "brand": "visa",
            "last4": "4242",
        }])
        bot._set_pending_ucp_products_sync(1234, [{
            "choiceId": "11111111-1111-4111-8111-111111111111",
            "productName": "Vitamin C",
        }])

        bot._clear_pending_shopping_context_sync(1234)

        self.assertIsNone(bot._get_pending_action_sync(1234))
        self.assertIsNone(bot._get_pending_ucp_card_sync(1234, 0))
        self.assertEqual(bot._get_pending_ucp_products_sync(1234), [])

    def test_round_trips_add_card_choice_for_mandate_setup(self):
        choices = [{
            "type": "add_card",
            "label": "Add a new saved card",
            "token": "signed-add-card-choice",
        }]
        bot._set_pending_ucp_cards_sync(1234, choices)
        saved = bot._get_pending_ucp_card_sync(1234, 0)
        self.assertEqual(saved["type"], "add_card")
        self.assertEqual(saved["token"], choices[0]["token"])
        self.assertEqual(bot._card_choice_label(saved), choices[0]["label"])
        bot._clear_pending_ucp_cards_sync(1234)

    def test_round_trips_and_renders_every_one_time_mandate_choice(self):
        choices = [
            {
                "type": "ucp_mandate",
                "label": f"Use mandate ending 00{index}",
                "token": f"signed-mandate-{index}",
                "mandateId": f"mdt_{index}",
                "remaining": str(100 + index),
                "currency": "INR",
                "frequency": "one_time",
                "merchantScope": "any",
            }
            for index in range(1, 11)
        ]
        message = SimpleNamespace(reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )

        asyncio.run(bot._send_hermes_result(
            update,
            {"message": "Choose a payment method.", "cardChoices": choices},
            {"userId": 42},
        ))

        saved_last = bot._get_pending_ucp_card_sync(1234, 9)
        self.assertEqual(saved_last["mandateId"], "mdt_10")
        self.assertEqual(saved_last["merchantScope"], "any")
        rendered = message.reply_text.await_args_list[-1].kwargs["reply_markup"]
        self.assertEqual(len(rendered.inline_keyboard), 10)
        self.assertEqual(
            rendered.inline_keyboard[-1][0].callback_data,
            "ucpcard:9",
        )

    def test_renders_mandate_and_other_payment_as_one_choice_panel(self):
        payment_url = "https://tokko-shopper.example/payments/options?s=signed"
        choices = [{
            "type": "ucp_mandate",
            "label": "Use one-time Prava mandate ending D123",
            "token": "signed-mandate-choice",
            "remaining": "400.00",
            "currency": "INR",
        }]
        message = SimpleNamespace(reply_text=AsyncMock())
        update = SimpleNamespace(
            effective_chat=SimpleNamespace(id=1234),
            effective_message=message,
            message=message,
        )

        asyncio.run(bot._send_hermes_result(
            update,
            {
                "message": "Choose a payment method.",
                "cardChoices": choices,
                "nextAction": {
                    "type": "prava_payment_options",
                    "label": "Use another payment method with Prava",
                    "url": payment_url,
                },
            },
            {"userId": 42},
        ))

        self.assertEqual(message.reply_text.await_count, 1)
        sent = message.reply_text.await_args
        self.assertIn("Choose one Prava payment option", sent.args[0])
        markup = sent.kwargs["reply_markup"]
        self.assertEqual(len(markup.inline_keyboard), 2)
        self.assertEqual(
            [row[0].callback_data for row in markup.inline_keyboard],
            ["ucpcard:0", "ucpcard:1"],
        )
        self.assertEqual(
            markup.inline_keyboard[0][0].text,
            "Use one-time Prava mandate · INR 400.00 left",
        )
        self.assertEqual(
            markup.inline_keyboard[1][0].text,
            "Use another payment method",
        )
        self.assertIsNone(markup.inline_keyboard[1][0].url)
        saved_other = bot._get_pending_ucp_card_sync(1234, 1)
        self.assertEqual(saved_other["type"], "prava_payment_options")
        self.assertEqual(saved_other["url"], payment_url)

    def test_other_payment_choice_removes_options_before_revealing_secure_link(self):
        payment_url = "https://tokko-shopper.example/payments/options?s=signed"
        bot._set_pending_ucp_cards_sync(1234, [{
            "type": "prava_payment_options",
            "label": "Use another payment method",
            "url": payment_url,
        }])
        query = SimpleNamespace(
            data="ucpcard:0",
            answer=AsyncMock(),
            edit_message_text=AsyncMock(),
            edit_message_reply_markup=AsyncMock(),
            message=SimpleNamespace(reply_text=AsyncMock()),
        )
        update = SimpleNamespace(
            callback_query=query,
            effective_chat=SimpleNamespace(id=1234),
            effective_message=query.message,
        )
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "_select_ucp_card", AsyncMock()) as select_card,
        ):
            asyncio.run(bot.select_ucp_saved_card(
                update,
                SimpleNamespace(bot=SimpleNamespace()),
            ))

        query.edit_message_text.assert_awaited_once()
        query.edit_message_reply_markup.assert_awaited_once_with(reply_markup=None)
        self.assertIn(
            "Payment option selected: Use another payment method",
            query.edit_message_text.await_args.args[0],
        )
        select_card.assert_not_awaited()
        secure_call = query.message.reply_text.await_args
        self.assertEqual(secure_call.args[0], "Continue securely with Prava:")
        secure_button = secure_call.kwargs["reply_markup"].inline_keyboard[0][0]
        self.assertEqual(secure_button.url, payment_url)
        self.assertIsNone(bot._get_pending_ucp_card_sync(1234, 0))

    def test_mandate_choice_is_consumed_and_removes_all_payment_buttons(self):
        choice = {
            "type": "ucp_mandate",
            "token": "signed-mandate-choice",
            "remaining": "400.00",
            "currency": "INR",
        }
        bot._set_pending_ucp_cards_sync(1234, [choice])
        query = SimpleNamespace(
            data="ucpcard:0",
            answer=AsyncMock(),
            edit_message_text=AsyncMock(),
            edit_message_reply_markup=AsyncMock(),
            message=SimpleNamespace(reply_text=AsyncMock()),
        )
        update = SimpleNamespace(
            callback_query=query,
            effective_chat=SimpleNamespace(id=1234),
            effective_message=query.message,
        )
        context = SimpleNamespace(bot=SimpleNamespace())
        binding = {"userId": 42, "customerId": "tokko_family_42"}
        selected_result = {"message": "Mandate selected."}
        with (
            patch.object(bot, "get_family_binding", AsyncMock(return_value=binding)),
            patch.object(bot, "_telegram_return_context", AsyncMock(return_value={
                "returnContext": {"botUsername": "TokkoShopperBot"},
            })),
            patch.object(bot, "_select_ucp_card", AsyncMock(return_value=selected_result)) as select_card,
            patch.object(bot, "_send_hermes_result", AsyncMock()) as send_result,
        ):
            asyncio.run(bot.select_ucp_saved_card(update, context))

        query.edit_message_text.assert_awaited_once()
        query.edit_message_reply_markup.assert_awaited_once_with(reply_markup=None)
        select_card.assert_awaited_once_with(
            1234,
            binding,
            choice["token"],
            "TokkoShopperBot",
        )
        send_result.assert_awaited_once_with(update, selected_result, binding)
        self.assertIsNone(bot._get_pending_ucp_card_sync(1234, 0))


if __name__ == "__main__":
    unittest.main()
