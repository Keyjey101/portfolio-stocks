from __future__ import annotations

from collections.abc import Iterable, Sequence
from datetime import datetime, date, time
from io import BytesIO
from json import loads as json_loads
from typing import Any, Literal
from warnings import warn
from zipfile import ZipFile

from lxml.html import parse

from .core import Core


class Tradernet(Core):
    """
    Client methods to interact Tradernet API.
    """
    def new_user(
        self,
        login: str,
        reception: str | int,
        phone: str,
        lastname: str,
        firstname: str,
        password: str | None = None,
        utm_campaign: str | None = None,
        tariff: int | None = None
    ) -> dict[str, str | int]:
        """
        Creating a new user.

        Parameters
        ----------
        login : str
            A login.
            A password.
        reception : str | int
            A reception number.
        phone : str | None
            User's phone no.
        lastname : str | None
            User's last name.
        firstname : str | None
            User's first name.
        password : str | None
            User's password. If None, it will be generated automatically.
        utm_campaign : str | None
            Referral link. This field is used if a new user is created after
            receiving a referral link.
        tariff : int | None
            Selected rate ID. Optional parameter. During the registration, you
            may immediately assign the desired rate ID.

        Returns
        -------
        dict[str, str | int]
            A dictionary with the following keys: 'clientId', 'userId'.

        Notes
        -----
        https://freedom24.com/tradernet-api/primary-registration
        """
        return self.plain_request(
            'registerNewUser',
            {
                'login': login,
                'pwd': password,
                'reception': str(reception),
                'phone': phone,
                'lastname': lastname,
                'firstname': firstname,
                'tariff_id': tariff,
                'utm_campaign': utm_campaign
            }
        )

    def check_missing_fields(self, step: int, office: str) -> dict[str, Any]:
        """
        Checking missing (blank) fields. If any fields are missing, they will
        be specified in the `not_completed` parameter, along with a
        description.

        Parameters
        ----------
        step : int
            A step number.
        office : str
            An office name.

        Notes
        -----
        https://freedom24.com/tradernet-api/check-step
        """
        return self.authorized_request(
            'checkStep',
            {'step': step, 'office': office}
        )

    def get_profile_fields(self, reception: int) -> dict[str, Any]:
        """
        Obtaining profile fields for different offices.

        Parameters
        ----------
        reception : int
            A reception number.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-anketa-fields
        """
        return self.authorized_request(
            'getAnketaFields',
            {'anketa_for_reception': reception}
        )

    def user_info(self) -> dict[str, Any]:
        """
        Obtaining user information.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-user-info
        """
        return self.authorized_request('GetAllUserTexInfo')

    def get_user_data(self) -> dict[str, Any]:
        """
        Getting initial user data from the server - orders, portfolio, markets,
        open sessions, etc.

        Notes
        -----
        https://freedom24.com/tradernet-api/auth-get-opq
        """
        return self.authorized_request('getOPQ')

    def get_market_status(
        self,
        market: str = '*',
        mode: str | None = None
    ) -> dict[str, Any]:
        """
        Obtaining information about market statuses and operation.

        Parameters
        ----------
        market : str
            A market code (briefName).
        mode : str | None
            Request mode: demo. If the parameter is not specified, the market
            statuses for real users will be displayed.

        Notes
        -----
        https://freedom24.com/tradernet-api/market-status
        """
        params = {'market': market}
        if mode:
            params['mode'] = mode

        return self.authorized_request(
            'getMarketStatus',
            params
        )

    def security_info(self, symbol: str, sup: bool = True) -> dict[str, Any]:
        """
        Getting info on a specific symbol.

        Parameters
        ----------
        symbol : str
            A Tradernet symbol.
        sup : bool
            IMS and trading system format.

        Returns
        -------
        result : dict
            A dictionary of symbol info.

        Notes
        -----
        https://freedom24.com/tradernet-api/quotes-get-info
        """
        return self.authorized_request(
            'getSecurityInfo',
            {'ticker': symbol, 'sup': sup}
        )

    def get_options(
        self,
        underlying: str,
        exchange: str
    ) -> list[dict[str, str]]:
        """
        Downloading a list of active options by the underlying asset and
        exchange.

        Parameters
        ----------
        underlying : str
            The underlying symbol.
        exchange : str
            A venue options traded.

        Returns
        -------
        list[dict[str, str]]
            List of very basic properties of options.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-options-by-mkt
        """
        return self.authorized_request(
            'getOptionsByMktNameAndBaseAsset',
            {'base_contract_code': underlying, 'ltr': exchange}
        )

    def get_most_traded(
        self,
        instrument_type: str = 'stocks',
        exchange: str = 'usa',
        gainers: bool = True,
        limit: int = 10
    ) -> dict[str, Any]:
        """
        Getting a list of the most traded securities or a list of the fastest
        growing stocks (for a year).

        Parameters
        ----------
        instrument_type : str
            Instrument type.
        exchange : str
            Stock exchanges. Possible values: 'usa', 'europe', 'ukraine',
            'currencies'.
        gainers : bool
            True: top fastest-growing, False: top by trading volume.
        limit : int
            Number of instruments displayed.

        Notes
        -----
        https://freedom24.com/tradernet-api/quotes-get-top-securities
        """
        return self.plain_request(
            'getTopSecurities',
            {
                'type': instrument_type,
                'exchange': exchange,
                'gainers': int(gainers),
                'limit': limit
            }
        )

    def get_candles(
        self,
        symbol: str,
        start: datetime = datetime(2010, 1, 1),
        end: datetime = datetime.now(),
        timeframe: int = 86400
    ) -> dict[str, Any]:
        """
        Getting historical data of a symbol.

        Parameters
        ----------
        symbol : str
            A symbol name on Tradernet.
        start : datetime
            The first date of the period market data to be acquired within.
        end : datetime
            The last date of the period.
        timeframe : int
            Timeframe of candles in seconds. Default is 86400 corresponding to
            day candles. -1 value of the parameter indicating that traders are
            required.

        Returns
        -------
        result : dict
            A dictionary of historical information of the symbol.

        Notes
        -----
        https://freedom24.com/tradernet-api/quotes-get-hloc
        https://freedom24.com/tradernet-api/get-trades
        """
        return self.authorized_request(
            'getHloc',
            {
                'id': symbol,
                'count': -1,
                'timeframe': int(timeframe / 60),
                'date_from': start.strftime('%d.%m.%Y %H:%M'),
                'date_to': end.strftime('%d.%m.%Y %H:%M'),
                'intervalMode': 'OpenRay'
            }
        )

    def get_trades_history(
        self,
        start: str | date = date(1970, 1, 1),
        end: str | date = date.today(),
        trade_id: int | None = None,
        limit: int | None = None,
        symbol: str | None = None,
        currency: str | None = None
    ) -> dict[str, Any]:
        """
        Getting a list of trades.

        Parameters
        ----------
        start : date
            Period start date.
        end : date
            Period end date.
        trade_id : int | None
            From which Trade ID to start retrieving report data.
        limit : int | None
            Number of trades. If 0 or no parameter is specified - then all
            trades.
        symbol : str | None
            A symbol.
        currency : str | None
            Base currency or quote currency.

        Returns
        -------
        result : dict
            A dictionary of trades.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-trades-history
        """
        params: dict[str, str | int] = {
            'beginDate': str(start),
            'endDate': str(end)
        }

        if trade_id is not None:
            params['tradeId'] = trade_id

        if limit is not None:
            params['max'] = limit

        if symbol is not None:
            params['nt_ticker'] = symbol

        if currency is not None:
            params['curr'] = currency

        return self.authorized_request(
            'getTradesHistory',
            params
        )

    def find_symbol(
        self,
        symbol: str,
        exchange: str | None = None
    ) -> dict[str, Any]:
        """
        Stock symbols search.

        Parameters
        ----------
        symbol : str
            A symbol name.
        exchange : str, optional
            Refbook name.

        Returns
        -------
        result : dict
            A dictionary of symbols, max 30.

        Notes
        -----
        https://freedom24.com/tradernet-api/quotes-finder
        """
        return self.plain_request(
            'tickerFinder',
            {'text': f'{symbol}@{exchange}' if exchange else symbol}
        )

    def get_news(
        self,
        query: str,
        symbol: str | None = None,
        story_id: str | None = None,
        limit: int = 30
    ) -> dict[str, Any]:
        """
        Getting news on securities.

        Parameters
        ----------
        query : str
            Can be ticker or any word.
        symbol : str | None
            If parameter symbol is set, `query` will be ignored and newsfeed
            will consist only of stories solely based on mentioned symbol.
        story_id : str | None
            If parameter story_id is set, `query` and `symbol` parameters will
            be ignored and news feed will consist only of the story with
            required storyId.
        limit : int
            Max number of news, 30 by default.

        Notes
        -----
        https://freedom24.com/tradernet-api/quotes-get-news
        """
        return self.authorized_request(
            'getNews',
            {
                'searchFor': query,
                'ticker': symbol,
                'storyId': story_id,
                'limit': limit
            }
        )

    def get_all(
        self,
        filters: dict[str, Any] | None = None,
        show_expired: bool = False
    ) -> list[dict[str, Any]]:
        """
        Getting information on securities.

        Parameters
        ----------
        filters : dict, optional
            Field names and their values.
        show_expired : bool, optional
            Getting expired symbols or not.

        Returns
        -------
        result : dict
            A dictionary of symbols.

        Notes
        -----
        https://freedom24.com/tradernet-api/securities
        https://freedom24.com/tradernet-api/instruments - instrument types

        Examples
        --------
        >>> await self.get_all(
                filters={'mkt_short_code': 'FIX', 'instr_type_c': 1}
            )
        [dict(...)]

        This command obtains all stocks of the FIX venue.

        >>> await self.get_all(
                filters={'mkt_short_code': 'ICE', 'instr_type_c': 4}
            )
        [dict(...)]

        And this one obtains all active options from the ICE exchange.
        """
        if not filters:
            filters = {}

        if not show_expired:
            filters['istrade'] = 1

        return [
            symbol for symbol
            in self.__get_refbook(filters.get('mkt_short_code'))
            if all(symbol[field] == filters[field] for field in filters)
        ]

    def account_summary(self) -> dict[str, Any]:
        """
        Getting summary of own account.

        Returns
        -------
        result : dict
            A dictionary of all positions, active orders, etc.

        Notes
        -----
        https://freedom24.com/tradernet-api/portfolio-get-changes
        """
        return self.authorized_request('getPositionJson')

    def get_price_alerts(self, symbol: str | None = None) -> dict[str, Any]:
        """
        Getting a list of price alerts.

        Parameters
        ----------
        symbol : str | None, optional
            Symbol to get alerts for.

        Returns
        -------
        result : dict
            A dictionary of alerts.

        Notes
        -----
        https://freedom24.com/tradernet-api/alerts-get-list
        """
        return self.authorized_request(
            'getAlertsList',
            {'ticker': symbol} if symbol else {}
        )

    def add_price_alert(
        self,
        symbol: str,
        price: int | float | str | Iterable[int | float | str],
        trigger_type: str = 'crossing',
        quote_type: str = 'ltp',
        send_to: str = 'email',
        frequency: int = 0,
        expire: int = 0
    ) -> dict[str, Any]:
        """
        Adding a price alert.

        Parameters
        ----------
        symbol : str
            Symbol to add alert for.
        price : float | list[float]
            Price of the alert activation.
        trigger_type : str, optional
            Trigger method.
        quote_type : str, optional
            Type of the price underlying the alert calculation. Possible
            values: 'ltp', 'bap', 'bbp', 'op', 'pp'.
        send_to : str, optional
            Type of notification. Possible values: 'email', 'sms', 'push',
            'all', by default 'email'.
        frequency : int, optional
            Frequency.
        expire : int, optional
            Alert period.

        Returns
        -------
        result : dict
            Addition result.

        Notes
        -----
        https://freedom24.com/tradernet-api/alerts-add
        """
        if not isinstance(price, Iterable):
            price = [str(price)]
        else:
            price = [*map(str, price)]

        return self.authorized_request(
            'addPriceAlert',
            {
                'ticker': symbol,
                'price': price,
                'trigger_type': trigger_type,
                'quote_type': quote_type,
                'notification_type': send_to,
                'alert_period': frequency,
                'expire': expire
            }
        )

    def delete_price_alert(self, alert_id: int) -> dict[str, Any]:
        """
        Deleting a price alert.

        Parameters
        ----------
        alert_id : int
            Alert ID.

        Returns
        -------
        result : dict
            Deletion result.

        Notes
        -----
        https://freedom24.com/tradernet-api/alerts-delete
        """
        return self.authorized_request(
            'addPriceAlert',
            {'id': alert_id, 'del': True}
        )

    def get_requests_history(
        self,
        doc_id: int | None = None,
        exec_id: int | None = None,
        start: date = datetime(2011, 1, 11),
        end: date = datetime.now(),
        limit: int | None = None,
        offset: int | None = None,
        status: int | None = None
    ) -> dict[str, Any]:
        """
        Receiving clients' requests history.

        Parameters
        ----------
        doc_id : int | None, optional
            Request type ID.
        exec_id : int | None, optional
            Order ID.
        start : date, optional
            Period start date.
        end : date, optional
            Period end date.
        limit : int | None, optional
            Number of orders displayed in the list.
        offset : int | None, optional
            Step of the list of displayed requests.
        status : int | None, optional
            Requests statuses: 0 - draft request; 1 - in process of execution;
            2 - request is rejected; 3 - request is executed.

        Returns
        -------
        result : dict
            Clients' requests for the specified period.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-client-cps-history
        """
        params: dict[str, str | int] = {
            'date_from': start.strftime('%Y-%m-%dT%H:%M:%S'),
            'date_to': end.strftime('%Y-%m-%dT%H:%M:%S')
        }

        if doc_id:
            params['cpsDocId'] = doc_id
        if exec_id:
            params['id'] = exec_id
        if limit:
            params['limit'] = limit
        if offset:
            params['offset'] = offset
        if status:
            params['cps_status'] = status

        return self.authorized_request(
            'getClientCpsHistory',
            params
        )

    def get_order_files(
        self,
        order_id: int | None,
        internal_id: int | None
    ) -> dict[str, Any]:
        """
        Receiving order files.

        Parameters
        ----------
        order_id : int | None, optional
            Order ID. May be not used if the draft order ID is known
            (internal_id).
        internal_id : int | None, optional
            Draft order number. Used when known, or if the order has the draft
            status and has not yet been assigned the main ID.

        Returns
        -------
        result : dict
            Order files.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-cps-files
        """
        params: dict[str, int] = {}

        if internal_id:
            params['internal_id'] = internal_id
        elif order_id:
            params['id'] = order_id
        else:
            raise ValueError(
                'Either order_id or internal_id must be specified'
            )

        return self.authorized_request(
            'getCpsFiles',
            params
        )

    def send_money(
        self,
        quantity: float,
        currency: str,
        receiver: str,
        type: Literal[
            'own_accounts',
            'other_client',
            'to_off_balance',
            'to_card',
            'card_to_card'
        ] = 'own_accounts',
        sender: str | None = None,
        receiver_name: str | None = None,
        comment: str | None = None
    ) -> dict[str, Any]:
        """
        Sending money out.
        """
        if quantity <= 0:
            raise ValueError('Quantity must be positive')

        match type:
            case 'own_accounts':
                params: dict[str, str | int] = {'account': receiver}
            case 'other_client':
                if not receiver_name:
                    raise ValueError("Receiver's name is not provided")
                params = {
                    'account': receiver,
                    'receiver_name': receiver_name
                }
            case 'to_off_balance':
                params = {'off_balance_id': int(receiver)}
            case 'to_card':
                params = {'card_id': receiver}
            case 'card_to_card':
                if not sender:
                    raise ValueError('Sender is not provided')
                params = {
                    'card_id': sender,
                    'card_id_recipient': receiver,
                    'sender_trader_systems_id': ''
                }
            case _:
                raise ValueError('Unknown transfer type')

        return self.submit_cps(
            200,
            {
                'transfer_type': type,
                'currency': currency,
                'amount': quantity,
                'sender_trader_systems_id': sender,
                'comment': comment,
                **params
            }
        )

    def accept_transfer(
        self,
        transfer_id: int,
        accept: bool = True,
        receiver: str | None = None,
        auto_accept: bool = False
    ) -> dict[str, Any]:
        """
        Accepting or rejecting an incoming money transfer (CPS 200).

        Parameters
        ----------
        transfer_id : int
            The sender's order ID, must be in the 'in process' status.
        accept : bool, optional
            True to accept the transfer, False to reject it. By default True.
        receiver : str | None, optional
            The receiving account (trader_systems_id) on the recipient side.
        auto_accept : bool, optional
            True to accept future transfers from this sender without
            confirmation. By default False.
        """
        return self.submit_cps(
            200,
            {
                'incoming_cps_id': transfer_id,
                'incoming_cps_decision': 'on' if accept else 'off',
                'incoming_cps_receiver_trader_systems_id': receiver,
                'incoming_cps_auto_accept': 'on' if auto_accept else 'off'
            }
        )

    def get_broker_report(
        self,
        start: str | date = date(1970, 1, 1),
        end: str | date = date.today(),
        period: time = time(23, 59, 59)
    ) -> dict[str, Any]:
        """
        Getting the JSON brokerage report.
        """
        report: dict[str, Any] = {}
        for part_name in (
            'account_at_start',
            'account_at_end',
            'trades',
            'commissions',
            'corporate_actions',
            'in_outs',
            'in_outs_securities',
            'cash_flows',
            'securities_flows'
        ):
            report_part = self.authorized_request(
                'getBrokerReport',
                {
                    'date_start': str(start),
                    'date_end': str(end),
                    'time_period': period.strftime('%H:%M:%S'),
                    'format': 'json',
                    'type': part_name
                }
            )
            report[part_name] = report_part['report']

        return report


    def symbol(self, symbol: str, lang: str = 'en') -> dict[str, Any]:
        """
        A method for obtaining information on a given security.

        Parameters
        ----------
        symbol : str
            A Tradernet symbol.
        lang : str
            Language, two letters.

        Returns
        -------
        result : dict
            A dictionary of symbol info.

        Notes
        -----
        https://freedom24.com/tradernet-api/shop-get-stock-data
        """
        return self.authorized_request(
            'getStockData',
            {'ticker': symbol, 'lang': lang}
        )

    def symbols(self, exchange: str | None = None) -> dict[str, Any]:
        """
        Receiving completed lists of securities.

        Parameters
        ----------
        exchange : str, optional
            Optional parameter that allows to get data from NYSE and NASDAQ or
            Moscow Exchange. May accept the value USA, Russia.

        Returns
        -------
        result : dict
            A dictionary of exchanges and symbols.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-ready-list
        """
        return self.authorized_request(
            'getReadyList',
            {'mkt': exchange.lower()} if exchange else None
        )

    def corporate_actions(
        self,
        reception: int = 35
    ) -> list[dict[str, Any]]:
        """
        Getting planned corporate actions for a certain office.

        Parameters
        ----------
        reception : 35
            Office number.

        Returns
        -------
        result : list
            Expected corporate actions.
        """
        return self.authorized_request(
            'getPlannedCorpActions',
            {'reception': reception}
        )

    def get_quotes(self, symbols: Sequence[str]) -> dict[str, Any]:
        """
        Getting quotes for a list of symbols.

        Parameters
        ----------
        symbols : Sequence[str]
            A sequence of symbols or a symbol.

        Returns
        -------
        result : dict
            A dictionary of quotes.

        Notes
        -----
        https://freedom24.com/tradernet-api/quotes-get
        """
        if isinstance(symbols, str):
            symbols = [symbols]

        return self.authorized_request(
            'getStockQuotesJson',
            {'tickers': ','.join(symbols)}
        )

    def buy(
        self,
        symbol: str,
        quantity: int = 1,
        price: float = 0.0,
        duration: str = 'day',
        use_margin: bool = True,
        custom_order_id: int | None = None
    ) -> dict[str, Any]:
        """
        Placing a new buy order.

        Parameters
        ----------
        symbol : str
            Tradernet symbol.
        quantity : int, optional
            Units of the symbol, by default 1.
        price : float, optional
            Limit price, by default 0.0 that means market order.
        duration : str, optional
            Time to order expiration, by default 'day'.
        use_margin : bool, optional
            If margin credit might be used, by default True.
        custom_order_id : int, optional
            Custom order ID, by default None meaning that it will be generated
            by Tradernet.

        Returns
        -------
        dict[str, Any]
            Order information.
        """
        if quantity <= 0:
            raise ValueError('Quantity must be positive')

        return self.place_order(
            symbol,
            quantity,
            price,
            duration,
            use_margin,
            custom_order_id
        )

    def sell(
        self,
        symbol: str,
        quantity: int = 1,
        price: float = 0.0,
        duration: str = 'day',
        use_margin: bool = True,
        custom_order_id: int | None = None
    ) -> dict[str, Any]:
        """
        Placing a new sell order.

        Parameters
        ----------
        symbol : str
            Tradernet symbol.
        quantity : int, optional
            Units of the symbol, by default 1.
        price : float, optional
            Limit price, by default 0.0 that means market order.
        duration : str, optional
            Time to order expiration, by default 'day'.
        use_margin : bool, optional
            If margin credit might be used, by default True.
        """
        if quantity <= 0:
            raise ValueError('Quantity must be positive')

        return self.place_order(
            symbol,
            -quantity,
            price,
            duration,
            use_margin,
            custom_order_id
        )

    def stop(self, symbol: str, price: float) -> dict[str, Any]:
        """
        Placing a new stop order on a certain open position.

        Parameters
        ----------
        symbol : str
            Tradernet symbol.
        price : float
            Stop price.

        Returns
        -------
        dict[str, Any]
            Order information.
        """
        return self.authorized_request(
            'putStopLoss',
            {'instr_name': symbol, 'stop_loss': price}
        )

    def trailing_stop(self, symbol: str, percent: int = 1) -> dict[str, Any]:
        """
        Placing a new trailing stop order on a certain open position.

        Parameters
        ----------
        symbol : str
            Tradernet symbol.
        percent : int, optional
            Stop loss percentage, by default 1.

        Returns
        -------
        dict[str, Any]
            Order information.
        """
        return self.authorized_request(
            'putStopLoss',
            {
                'instr_name': symbol,
                'stop_loss_percent': percent,
                'stoploss_trailing_percent': percent
            }
        )

    def take_profit(self, symbol: str, price: float) -> dict[str, Any]:
        """
        Placing a new take profit order on a certain open position.

        Parameters
        ----------
        symbol : str
            Tradernet symbol.
        price : float
            Take profit price.

        Returns
        -------
        dict[str, Any]
            Order information.
        """
        return self.authorized_request(
            'putStopLoss',
            {'instr_name': symbol, 'take_profit': price}
        )

    def cancel(self, order_id: int) -> dict[str, Any]:
        """
        Cancelling an order.

        Parameters
        ----------
        order_id : int
            Order ID.
        """
        return self.authorized_request(
            'delTradeOrder',
            {'order_id': order_id}
        )

    def cancel_all(self) -> list[dict[str, Any]]:
        """
        Cancelling all orders.
        """
        active_orders = self.get_placed()['result']['orders']
        if 'order' not in active_orders:
            return []

        return [self.cancel(order['id']) for order in active_orders['order']]

    def get_placed(self, active: bool = True) -> dict[str, Any]:
        """
        Getting a list of orders in the current period.

        Parameters
        ----------
        active : bool, optional
            Show only active orders.

        Returns
        -------
        result : dict
            A dictionary of orders.

        Notes
        -----
        https://freedom24.com/tradernet-api/orders-get-current-history
        """
        return self.authorized_request(
            'getNotifyOrderJson',
            {'active_only': int(active)}
        )

    def get_historical(
        self,
        start: datetime = datetime(2011, 1, 11),
        end: datetime = datetime.now()
    ) -> dict[str, Any]:
        """
        Getting a list of orders in the period.

        Parameters
        ----------
        start : datetime, optional
            Period start date.
        end : datetime, optional
            Period end date.

        Returns
        -------
        result : dict
            A dictionary of orders.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-orders-history
        """
        return self.authorized_request(
            'getOrdersHistory',
            {
                'from': start.strftime('%Y-%m-%dT%H:%M:%S'),
                'till': end.strftime('%Y-%m-%dT%H:%M:%S')
            }
        )

    def place_order(
        self,
        symbol: str,
        quantity: int = 1,
        price: float = 0.0,
        duration: str = 'day',
        use_margin: bool = True,
        custom_order_id: int | None = None
    ) -> dict[str, Any]:
        """
        Placing a new buy order.

        Parameters
        ----------
        symbol : str
            A Tradernet symbol.
        quantity : int, optional
            Units of the symbol, by default 1. If negative, then it is a sale.
        price : float, optional
            Limit price, by default 0.0 that means a market order.
        duration : str, optional
            Time to order expiration, by default 'day'.
        use_margin : bool, optional
            If margin credit might be used, True by default.
        custom_order_id : int, optional
            Custom order ID, by default None meaning that it will be generated
            by Tradernet.

        Returns
        -------
        dict[str, Any]
            Order information.
        """
        # IOC emulation is much slower than the real IOC, because emulation
        # requires two sent and two received FIX messages instead of only one
        # pair, so total execution time is about 0.5 sec.
        if duration == 'ioc':
            order = self.trade(
                symbol,
                quantity,
                price,
                'day',
                use_margin,
                custom_order_id
            )
            if 'order_id' in order:
                self.cancel(order['order_id'])
            return order

        duration = duration.lower()
        if duration not in self.DURATION:
            raise ValueError(f'Unknown duration {duration}')

        if quantity > 0:    # buy
            action_id = 2 if use_margin else 1
        elif quantity < 0:  # sale
            action_id = 4 if use_margin else 3
        else:
            raise ValueError('Zero quantity!')

        return self.authorized_request(
            'putTradeOrder',
            {
                'instr_name': symbol,
                'action_id': action_id,
                'order_type_id': 2 if price != 0 else 1,
                'qty': abs(quantity),
                'limit_price': price,
                'expiration_id': self.DURATION[duration],
                'user_order_id': custom_order_id
            }
        )

    def trade(
        self,
        symbol: str,
        quantity: int = 1,
        price: float = 0.0,
        duration: str = 'day',
        use_margin: bool = True,
        custom_order_id: int | None = None
    ) -> dict[str, Any]:
        return self.place_order(
            symbol,
            quantity,
            price,
            duration,
            use_margin,
            custom_order_id
        )

    def place_voice_order(
        self,
        symbol: str,
        quantity: int = 1,
        price: float = 0.0,
        duration: str = 'day',
        use_margin: bool = True,
        type: Literal['normal', 'structured_product', 'ipo'] = 'normal',
        comment: str | None = None
    ) -> dict[str, Any]:
        """
        Submitting a trade assignment or securities purchase (CPS 288 / 297).
        """
        export = self.export_securities(symbol)
        if len(export) != 1:
            raise ValueError(f'Symbol {symbol} not found')
        symbol_info = export[0]

        if type == 'normal':
            duration = duration.lower()
            if duration not in self.DURATION:
                raise ValueError(f'Unknown duration {duration}')

            if quantity > 0:    # buy
                action_id = 2 if use_margin else 1
            elif quantity < 0:  # sale
                action_id = 4 if use_margin else 3
            else:
                raise ValueError('Zero quantity!')

            return self.submit_cps(
                288,
                {
                    'instr': symbol,
                    'issue_nb': symbol_info['issue_nb'],
                    'full_name': None,
                    'oper': action_id,
                    'type': 2 if price != 0 else 1,
                    'q': abs(quantity),
                    'p': price,
                    'stop': None,
                    'cur': symbol_info['x_curr'],
                    'exp': self.DURATION[duration],
                    'auto_complete': 0,
                    'additional_comments': '' if not comment else comment
                }
            )

        if type == 'ipo':
            return self.submit_cps(
                297,
                {
                    'ipo_ticker': symbol,
                    'ipo_currency': symbol_info['x_curr'],
                    'ipo_sum': quantity,
                    'ipo_price': price,
                    'cps_account_from': None
                }
            )

        if type == 'structured_product':
            if quantity <= 0:
                raise ValueError(f"Invalid quantity of {symbol}")

            return self.submit_cps(
                297,
                {
                    'structured_product_ticker': symbol,
                    'structured_product_lot_size': quantity
                }
            )

        raise ValueError(f'Unknown voice order type {type!r}')

    def get_tariffs_list(self) -> dict[str, Any]:
        """
        Get a list of available tariffs.

        Returns
        -------
        dict[str, Any]
            Tariffs list.

        Notes
        -----
        https://freedom24.com/tradernet-api/get-list-tariff
        """
        return self.authorized_request('GetListTariffs')

    def __get_refbook(
        self,
        name: str | None = 'all',
        reference_date: date | None = None
    ) -> list[dict[str, Any]]:
        """
        Downloading and processing a particular reference book.

        Parameters
        ----------
        name : str
            The name of the book.

        Returns
        -------
        result : list
            The list of all instruments with their properties found in the
            reference book.
        """
        if not reference_date:
            reference_date = self.__latest_refbook()

        if not name or name == 'all':
            self.logger.warning(
                'Downloading all symbols may take a while '
                'and requires at least 40GB of RAM!'
            )

            result: list[dict[str, Any]] = []
            for refbook_name in self.__refbooks():
                result += self.__get_refbook(refbook_name, reference_date)

            return result

        uri = f'/refbooks/{reference_date}/{name}.json.zip'

        # Download and unzip
        response = self.request('get', url=f'{self.url}{uri}')
        content = response.content
        archive_json = self.__extract_zip(content)
        self.logger.debug(
            'Files in the archive: %s',
            ', '.join(archive_json.keys())
        )

        if len(archive_json) > 1:
            raise IOError('More than one file in the archive')

        return json_loads(archive_json[f'{name}.json'])

    def __refbooks(self) -> list[str]:
        """
        Getting the list of available reference books.

        Returns
        -------
        result : list
            The list of reference books for a specific date found.

        Notes
        -----
        https://freedom24.com/refbooks
        """
        reference_date = self.__latest_refbook()
        url = f'{self.url}/refbooks/{reference_date}'
        page = self.request('get', url)
        content = page.content
        doc = parse(BytesIO(content)).getroot()
        result = [
            div.text_content().rsplit('.', 2)[0]
            for div in doc.cssselect('a')
        ]
        result.remove('')
        return result

    def __latest_refbook(self) -> date:
        """
        Getting the latest reference book date.

        Returns
        -------
        result : date
            The latest reference book date.
        """
        url = f'{self.url}/refbooks'
        page = self.request('get', url)
        content = page.content
        doc = parse(BytesIO(content)).getroot()
        result = [
            div.text_content().rsplit('.', 2)[0]
            for div in doc.cssselect('a')
        ]

        return max(
            datetime.strptime(date_str, '%Y-%m-%d/').date()
            for date_str in result
            if date_str
        )

    @staticmethod
    def __extract_zip(content: bytes) -> dict[str, str]:
        """
        Extracting a zipped file into a dictionary having the structure
        "name->content".
        Parameters
        ----------
        content : bytes
            Byte-representation of an archive.
        Returns
        -------
        dict[str, str]
            Resulting dictionary.
        """
        with ZipFile(BytesIO(content)) as zip_file:
            return {
                name: zip_file.read(name).decode()
                for name in zip_file.namelist()
            }


class TraderNetAPI(Tradernet):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        warn(
            f"{self.__class__.__name__} is deprecated, use Tradernet instead",
            DeprecationWarning,
            stacklevel=2
        )
        super().__init__(*args, **kwargs)
